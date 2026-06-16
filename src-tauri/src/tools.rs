use crate::config::{augmented_path, SettingsState};
use chrono::{Duration, Local, Utc};
use serde_json::{json, Value};
use std::time::Duration as StdDuration;
use tauri::State;
use tokio::process::Command;
use tokio::time::timeout;

const CLI_TIMEOUT: StdDuration = StdDuration::from_secs(45);

/// Run a CLI with an augmented PATH and a hard timeout. Returns stdout on success.
async fn run_cli(program: &str, args: &[String]) -> Result<String, String> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .env("PATH", augmented_path())
        .kill_on_drop(true);
    let child = cmd.output();
    let out = timeout(CLI_TIMEOUT, child)
        .await
        .map_err(|_| format!("`{program}` timed out after {}s", CLI_TIMEOUT.as_secs()))?
        .map_err(|e| format!("failed to spawn `{program}`: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(format!(
            "`{program}` exited with {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

/// Run m365, optionally using a custom Entra app id (for scopes the default app lacks).
async fn run_m365(m365: &str, app_id: &str, args: &[String]) -> Result<String, String> {
    let mut cmd = Command::new(m365);
    cmd.args(args)
        .env("PATH", augmented_path())
        .kill_on_drop(true);
    if !app_id.trim().is_empty() {
        cmd.env("CLIMICROSOFT365_ENTRAAPPID", app_id);
    }
    let out = timeout(CLI_TIMEOUT, cmd.output())
        .await
        .map_err(|_| "m365 timed out".to_string())?
        .map_err(|e| format!("failed to spawn m365: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(format!(
            "{}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

// ---------------------------------------------------------------------------
// brain_search  ->  gbrain call query
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn brain_search(
    query: String,
    limit: Option<u32>,
    state: State<'_, SettingsState>,
) -> Result<String, String> {
    let (gbrain, limit) = {
        let s = state.0.lock().unwrap();
        (s.gbrain_path.clone(), limit.unwrap_or(5))
    };
    let payload = json!({ "query": query, "detail": "low", "limit": limit }).to_string();
    let args = vec!["call".to_string(), "query".to_string(), payload];

    // PGLite is single-connection: retry a few times if another process (e.g. a
    // Claude Code gbrain MCP session) is holding the lock.
    let mut last_err = String::new();
    for attempt in 0..4u32 {
        match run_cli(&gbrain, &args).await {
            Ok(stdout) => return Ok(format_brain_results(&stdout)),
            Err(e) => {
                last_err = e;
                if last_err.to_lowercase().contains("lock") {
                    tokio::time::sleep(StdDuration::from_millis(600 * (attempt + 1) as u64)).await;
                    continue;
                }
                break;
            }
        }
    }
    if last_err.to_lowercase().contains("lock") {
        Ok("(The brain is busy right now — another process is using it. \
             Tell the user the brain was momentarily locked and to try again in a moment.)"
            .to_string())
    } else {
        Err(format!("brain_search failed: {last_err}"))
    }
}

// ---------------------------------------------------------------------------
// brain_page  ->  gbrain call get_page (fuzzy)  — canonical compiled page by name
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn brain_page(
    name: String,
    state: State<'_, SettingsState>,
) -> Result<String, String> {
    let gbrain = { state.0.lock().unwrap().gbrain_path.clone() };
    let payload = json!({ "slug": name, "fuzzy": true }).to_string();
    let args = vec!["call".to_string(), "get_page".to_string(), payload];

    let mut last_err = String::new();
    for attempt in 0..4u32 {
        match run_cli(&gbrain, &args).await {
            Ok(stdout) => return Ok(format_brain_page(&stdout, &name)),
            Err(e) => {
                last_err = e;
                if last_err.to_lowercase().contains("lock") {
                    tokio::time::sleep(StdDuration::from_millis(600 * (attempt + 1) as u64)).await;
                    continue;
                }
                break;
            }
        }
    }
    // get_page returns non-zero / error text when the fuzzy match finds nothing.
    Ok(format!(
        "No canonical brain page found for \"{name}\". Try brain_search for broader context."
    ))
}

fn format_brain_page(stdout: &str, name: &str) -> String {
    let v: Value = match serde_json::from_str(stdout) {
        Ok(v) => v,
        Err(_) => return format!("No canonical brain page found for \"{name}\"."),
    };
    let title = v.get("title").and_then(|x| x.as_str()).unwrap_or(name);
    let slug = v.get("slug").and_then(|x| x.as_str()).unwrap_or("");
    let ptype = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
    let body = v
        .get("compiled_truth")
        .and_then(|x| x.as_str())
        .or_else(|| v.get("content").and_then(|x| x.as_str()))
        .unwrap_or("");
    if body.is_empty() {
        return format!("No canonical brain page found for \"{name}\".");
    }
    // The compiled page leads with the up-to-date role/summary; cap length for context.
    let snippet: String = body.chars().take(4000).collect();
    format!("Canonical brain page — {title} (type: {ptype}, slug: {slug}):\n\n{snippet}")
}

fn format_brain_results(stdout: &str) -> String {
    let parsed: Value = match serde_json::from_str(stdout) {
        Ok(v) => v,
        Err(_) => return stdout.trim().to_string(),
    };
    let arr = match parsed.as_array() {
        Some(a) if !a.is_empty() => a,
        _ => return "No matching pages found in the brain.".to_string(),
    };
    let mut out = String::from("Brain search results:\n\n");
    for (i, item) in arr.iter().enumerate() {
        let title = item
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("(untitled)");
        let slug = item.get("slug").and_then(|v| v.as_str()).unwrap_or("");
        let ptype = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let text = item
            .get("chunk_text")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let snippet: String = text.chars().take(900).collect();
        out.push_str(&format!(
            "[{}] {title}  (type: {ptype}, slug: {slug})\n{snippet}\n\n",
            i + 1
        ));
    }
    out
}

// ---------------------------------------------------------------------------
// calendar_events  ->  m365 request /me/calendarView
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn calendar_events(
    days: Option<i64>,
    state: State<'_, SettingsState>,
) -> Result<String, String> {
    let (m365, app_id) = {
        let s = state.0.lock().unwrap();
        (s.m365_path.clone(), s.m365_app_id.clone())
    };
    let days = days.unwrap_or(1).clamp(1, 31);

    // Local day window -> UTC for Graph calendarView.
    let now_local = Local::now();
    let start_local = now_local
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_local_timezone(Local)
        .unwrap();
    let end_local = start_local + Duration::days(days);
    let start_utc = start_local.with_timezone(&Utc);
    let end_utc = end_local.with_timezone(&Utc);

    let url = format!(
        "https://graph.microsoft.com/v1.0/me/calendarView?startDateTime={}&endDateTime={}&$select=id,subject,start,end,location,organizer,isAllDay,isOnlineMeeting&$orderby=start/dateTime&$top=50",
        start_utc.format("%Y-%m-%dT%H:%M:%SZ"),
        end_utc.format("%Y-%m-%dT%H:%M:%SZ"),
    );
    let args = vec![
        "request".to_string(),
        "--url".to_string(),
        url,
        "--output".to_string(),
        "json".to_string(),
    ];
    let stdout = run_m365(&m365, &app_id, &args).await?;
    Ok(format_calendar(&stdout, days))
}

fn format_calendar(stdout: &str, days: i64) -> String {
    let parsed: Value = match serde_json::from_str(stdout) {
        Ok(v) => v,
        Err(_) => return stdout.trim().to_string(),
    };
    let events = parsed
        .get("value")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if events.is_empty() {
        return format!("No calendar events in the next {days} day(s).");
    }
    let mut out = format!("Calendar (next {days} day(s), times in UTC):\n\n");
    for e in &events {
        let subj = e.get("subject").and_then(|v| v.as_str()).unwrap_or("(no subject)");
        let start = e
            .get("start")
            .and_then(|s| s.get("dateTime"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let end = e
            .get("end")
            .and_then(|s| s.get("dateTime"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let loc = e
            .get("location")
            .and_then(|l| l.get("displayName"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let id = e.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let teams = e.get("isOnlineMeeting").and_then(|v| v.as_bool()).unwrap_or(false);
        out.push_str(&format!("• {subj}{}\n  {start} → {end}", if teams { " [Teams]" } else { "" }));
        if !loc.is_empty() {
            out.push_str(&format!("  @ {loc}"));
        }
        if !id.is_empty() {
            out.push_str(&format!("\n  id: {id}"));
        }
        out.push('\n');
    }
    out
}

// ---------------------------------------------------------------------------
// calendar write  ->  m365 request POST/PATCH/DELETE /me/events  (+ onlineMeetings)
// ---------------------------------------------------------------------------

fn permission_hint(err: &str) -> String {
    if err.contains("403") || err.to_lowercase().contains("forbidden") || err.contains("ErrorAccessDenied") {
        format!(
            "macOS/Microsoft blocked this — the account is missing the Calendars.ReadWrite \
             permission. Tell Andres he needs to grant it (register the Entra app per the README) \
             before calendar events can be created or changed. ({err})"
        )
    } else {
        format!("Calendar request failed: {err}")
    }
}

async fn graph_write(
    m365: &str,
    app_id: &str,
    method: &str,
    url: &str,
    body: Option<String>,
) -> Result<String, String> {
    let mut args = vec![
        "request".to_string(),
        "--url".to_string(),
        url.to_string(),
        "--method".to_string(),
        method.to_string(),
        "--output".to_string(),
        "json".to_string(),
    ];
    if let Some(b) = body {
        args.push("--body".to_string());
        args.push(b);
        args.push("--content-type".to_string());
        args.push("application/json".to_string());
    }
    run_m365(m365, app_id, &args).await
}

/// Create a calendar event — optionally a Teams meeting, optionally with attendees
/// (who are emailed an invite). Times are ISO-8601 local datetimes (no Z), e.g.
/// "2026-06-17T10:00:00". Needs the Calendars.ReadWrite permission.
#[tauri::command]
pub async fn calendar_create(
    subject: String,
    start: String,
    end: String,
    time_zone: Option<String>,
    attendees: Option<Vec<String>>,
    is_teams: Option<bool>,
    location: Option<String>,
    body: Option<String>,
    state: State<'_, SettingsState>,
) -> Result<String, String> {
    let (m365, app_id) = {
        let s = state.0.lock().unwrap();
        (s.m365_path.clone(), s.m365_app_id.clone())
    };
    let tz = time_zone.unwrap_or_else(|| "Central Standard Time".to_string());

    let mut ev = json!({
        "subject": subject,
        "start": { "dateTime": start, "timeZone": tz },
        "end": { "dateTime": end, "timeZone": tz },
    });
    if is_teams.unwrap_or(false) {
        ev["isOnlineMeeting"] = json!(true);
        ev["onlineMeetingProvider"] = json!("teamsForBusiness");
    }
    if let Some(loc) = location {
        if !loc.is_empty() {
            ev["location"] = json!({ "displayName": loc });
        }
    }
    if let Some(b) = body {
        if !b.is_empty() {
            ev["body"] = json!({ "contentType": "HTML", "content": b });
        }
    }
    if let Some(list) = attendees {
        let arr: Vec<Value> = list
            .into_iter()
            .filter(|a| a.contains('@'))
            .map(|a| json!({ "emailAddress": { "address": a }, "type": "required" }))
            .collect();
        if !arr.is_empty() {
            ev["attendees"] = json!(arr);
        }
    }

    match graph_write(
        &m365,
        &app_id,
        "post",
        "https://graph.microsoft.com/v1.0/me/events",
        Some(ev.to_string()),
    )
    .await
    {
        Ok(stdout) => {
            let v: Value = serde_json::from_str(&stdout).unwrap_or(Value::Null);
            let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("");
            let join = v
                .get("onlineMeeting")
                .and_then(|o| o.get("joinUrl"))
                .and_then(|x| x.as_str())
                .unwrap_or("");
            let mut msg = format!("Created \"{subject}\" for {start}.");
            if !join.is_empty() {
                msg.push_str(&format!(" Teams join link: {join}"));
            }
            if !id.is_empty() {
                msg.push_str(&format!(" (event id: {id})"));
            }
            Ok(msg)
        }
        Err(e) => Ok(permission_hint(&e)),
    }
}

/// Update an existing event (e.g. make it a Teams meeting, change time, add attendees).
#[tauri::command]
pub async fn calendar_update(
    event_id: String,
    subject: Option<String>,
    start: Option<String>,
    end: Option<String>,
    time_zone: Option<String>,
    is_teams: Option<bool>,
    location: Option<String>,
    state: State<'_, SettingsState>,
) -> Result<String, String> {
    let (m365, app_id) = {
        let s = state.0.lock().unwrap();
        (s.m365_path.clone(), s.m365_app_id.clone())
    };
    let tz = time_zone.unwrap_or_else(|| "Central Standard Time".to_string());
    let mut patch = json!({});
    if let Some(s) = subject {
        patch["subject"] = json!(s);
    }
    if let Some(s) = start {
        patch["start"] = json!({ "dateTime": s, "timeZone": tz });
    }
    if let Some(e) = end {
        patch["end"] = json!({ "dateTime": e, "timeZone": tz });
    }
    if is_teams.unwrap_or(false) {
        patch["isOnlineMeeting"] = json!(true);
        patch["onlineMeetingProvider"] = json!("teamsForBusiness");
    }
    if let Some(loc) = location {
        patch["location"] = json!({ "displayName": loc });
    }
    let url = format!("https://graph.microsoft.com/v1.0/me/events/{event_id}");
    match graph_write(&m365, &app_id, "patch", &url, Some(patch.to_string())).await {
        Ok(_) => Ok("Event updated.".into()),
        Err(e) => Ok(permission_hint(&e)),
    }
}

/// Delete a calendar event by id.
#[tauri::command]
pub async fn calendar_delete(
    event_id: String,
    state: State<'_, SettingsState>,
) -> Result<String, String> {
    let (m365, app_id) = {
        let s = state.0.lock().unwrap();
        (s.m365_path.clone(), s.m365_app_id.clone())
    };
    let url = format!("https://graph.microsoft.com/v1.0/me/events/{event_id}");
    match graph_write(&m365, &app_id, "delete", &url, None).await {
        Ok(_) => Ok("Event deleted.".into()),
        Err(e) => Ok(permission_hint(&e)),
    }
}

/// Create a standalone Teams meeting (no calendar event) and return its join link.
/// Works with the OnlineMeetings.ReadWrite permission the account already has.
#[tauri::command]
pub async fn create_teams_meeting(
    subject: String,
    start: String,
    end: String,
    state: State<'_, SettingsState>,
) -> Result<String, String> {
    let (m365, app_id) = {
        let s = state.0.lock().unwrap();
        (s.m365_path.clone(), s.m365_app_id.clone())
    };
    let body = json!({
        "subject": subject,
        "startDateTime": start,
        "endDateTime": end,
    })
    .to_string();
    match graph_write(
        &m365,
        &app_id,
        "post",
        "https://graph.microsoft.com/v1.0/me/onlineMeetings",
        Some(body),
    )
    .await
    {
        Ok(stdout) => {
            let v: Value = serde_json::from_str(&stdout).unwrap_or(Value::Null);
            let join = v
                .get("joinUrl")
                .or_else(|| v.get("joinWebUrl"))
                .and_then(|x| x.as_str())
                .unwrap_or("");
            if join.is_empty() {
                Ok("Created a Teams meeting, but no join link was returned.".into())
            } else {
                Ok(format!("Teams meeting ready: {join}"))
            }
        }
        Err(e) => Ok(permission_hint(&e)),
    }
}

// ---------------------------------------------------------------------------
// web_search  ->  Brave Search API
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn web_search(
    query: String,
    state: State<'_, SettingsState>,
) -> Result<String, String> {
    let key = { state.0.lock().unwrap().brave_api_key.clone() };
    if key.trim().is_empty() {
        return Ok("(Web search is not configured — no Brave API key set.)".to_string());
    }
    let client = reqwest::Client::new();
    let resp = client
        .get("https://api.search.brave.com/res/v1/web/search")
        .query(&[("q", query.as_str()), ("count", "5")])
        .header("Accept", "application/json")
        .header("X-Subscription-Token", key)
        .timeout(StdDuration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("Brave request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Brave returned HTTP {}", resp.status()));
    }
    let body: Value = resp.json().await.map_err(|e| e.to_string())?;
    let results = body
        .get("web")
        .and_then(|w| w.get("results"))
        .and_then(|r| r.as_array())
        .cloned()
        .unwrap_or_default();
    if results.is_empty() {
        return Ok("No web results found.".to_string());
    }
    let mut out = String::from("Web search results:\n\n");
    for (i, r) in results.iter().take(5).enumerate() {
        let title = r.get("title").and_then(|v| v.as_str()).unwrap_or("");
        let url = r.get("url").and_then(|v| v.as_str()).unwrap_or("");
        let desc = r.get("description").and_then(|v| v.as_str()).unwrap_or("");
        out.push_str(&format!("[{}] {title}\n{url}\n{desc}\n\n", i + 1));
    }
    Ok(out)
}
