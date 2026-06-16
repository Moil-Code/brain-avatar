use crate::config::{augmented_path, Settings, SettingsState};
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
// Remote brain-daemon proxy (MacBook client -> Mac Mini, over Tailscale)
// ---------------------------------------------------------------------------

/// Proxy a brain-owner tool call to the remote brain-daemon. Uses native Rust
/// HTTP (NOT webview fetch) so it bypasses WKWebView's App Transport Security,
/// and keeps the daemon token in Rust — never in the webview. Returns the tool's
/// text output (the daemon replies with the same string the local _core would).
pub(crate) async fn proxy(settings: &Settings, route: &str, body: Value) -> Result<String, String> {
    let base = settings.brain_daemon_url.trim_end_matches('/');
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{base}{route}"))
        .header(
            "Authorization",
            format!("Bearer {}", settings.brain_daemon_token),
        )
        .json(&body)
        .timeout(StdDuration::from_secs(120))
        .send()
        .await
        .map_err(|e| format!("brain-daemon unreachable: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if status.is_success() {
        Ok(text)
    } else {
        Err(format!(
            "brain-daemon HTTP {status}: {}",
            text.chars().take(300).collect::<String>()
        ))
    }
}

/// True when this app should proxy brain-owner tools to a remote daemon.
pub(crate) fn use_daemon(settings: &Settings) -> bool {
    !settings.brain_daemon_url.trim().is_empty()
}

/// Settings "Test connection": verify the daemon is reachable (/health) AND the
/// token is accepted (/auth/check, which is behind the bearer gate).
#[tauri::command]
pub async fn daemon_probe(url: String, token: String) -> Result<String, String> {
    let base = url.trim_end_matches('/');
    let client = reqwest::Client::new();
    let health = client
        .get(format!("{base}/health"))
        .timeout(StdDuration::from_secs(8))
        .send()
        .await
        .map_err(|e| format!("unreachable: {e}"))?;
    if !health.status().is_success() {
        return Err(format!("health check failed: HTTP {}", health.status()));
    }
    let auth = client
        .get(format!("{base}/auth/check"))
        .header("Authorization", format!("Bearer {token}"))
        .timeout(StdDuration::from_secs(8))
        .send()
        .await
        .map_err(|e| format!("unreachable: {e}"))?;
    match auth.status().as_u16() {
        200 => Ok("Connected — daemon reachable and token accepted.".into()),
        401 => Err("Reachable, but the token was rejected (401). Check it matches the daemon's BRAIN_DAEMON_TOKEN.".into()),
        other => Err(format!("auth check returned HTTP {other}")),
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
    let s = { state.0.lock().unwrap().clone() };
    if use_daemon(&s) {
        return proxy(&s, "/brain/search", json!({ "query": query, "limit": limit })).await;
    }
    brain_search_core(&s, query, limit).await
}

pub async fn brain_search_core(
    settings: &Settings,
    query: String,
    limit: Option<u32>,
) -> Result<String, String> {
    let gbrain = settings.gbrain_path.clone();
    let limit = limit.unwrap_or(5);
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
    let s = { state.0.lock().unwrap().clone() };
    if use_daemon(&s) {
        return proxy(&s, "/brain/page", json!({ "name": name })).await;
    }
    brain_page_core(&s, name).await
}

pub async fn brain_page_core(
    settings: &Settings,
    name: String,
) -> Result<String, String> {
    let gbrain = settings.gbrain_path.clone();
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
    let s = { state.0.lock().unwrap().clone() };
    if use_daemon(&s) {
        return proxy(&s, "/calendar/events", json!({ "days": days })).await;
    }
    calendar_events_core(&s, days).await
}

pub async fn calendar_events_core(
    settings: &Settings,
    days: Option<i64>,
) -> Result<String, String> {
    let m365 = settings.m365_path.clone();
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
    let stdout = run_m365(&m365, "", &args).await?;
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
    let s = { state.0.lock().unwrap().clone() };
    if use_daemon(&s) {
        return proxy(&s, "/calendar/create", json!({ "subject": subject, "start": start, "end": end, "time_zone": time_zone, "attendees": attendees, "is_teams": is_teams, "location": location, "body": body })).await;
    }
    calendar_create_core(&s, subject, start, end, time_zone, attendees, is_teams, location, body).await
}

#[allow(clippy::too_many_arguments)]
pub async fn calendar_create_core(
    settings: &Settings,
    subject: String,
    start: String,
    end: String,
    time_zone: Option<String>,
    attendees: Option<Vec<String>>,
    is_teams: Option<bool>,
    location: Option<String>,
    body: Option<String>,
) -> Result<String, String> {
    let m365 = settings.m365_path.clone();
    let app_id = settings.m365_app_id.clone();
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
    let s = { state.0.lock().unwrap().clone() };
    if use_daemon(&s) {
        return proxy(&s, "/calendar/update", json!({ "event_id": event_id, "subject": subject, "start": start, "end": end, "time_zone": time_zone, "is_teams": is_teams, "location": location })).await;
    }
    calendar_update_core(&s, event_id, subject, start, end, time_zone, is_teams, location).await
}

#[allow(clippy::too_many_arguments)]
pub async fn calendar_update_core(
    settings: &Settings,
    event_id: String,
    subject: Option<String>,
    start: Option<String>,
    end: Option<String>,
    time_zone: Option<String>,
    is_teams: Option<bool>,
    location: Option<String>,
) -> Result<String, String> {
    let m365 = settings.m365_path.clone();
    let app_id = settings.m365_app_id.clone();
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
    let s = { state.0.lock().unwrap().clone() };
    if use_daemon(&s) {
        return proxy(&s, "/calendar/delete", json!({ "event_id": event_id })).await;
    }
    calendar_delete_core(&s, event_id).await
}

pub async fn calendar_delete_core(
    settings: &Settings,
    event_id: String,
) -> Result<String, String> {
    let m365 = settings.m365_path.clone();
    let app_id = settings.m365_app_id.clone();
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
    let s = { state.0.lock().unwrap().clone() };
    if use_daemon(&s) {
        return proxy(&s, "/calendar/teams-meeting", json!({ "subject": subject, "start": start, "end": end })).await;
    }
    create_teams_meeting_core(&s, subject, start, end).await
}

pub async fn create_teams_meeting_core(
    settings: &Settings,
    subject: String,
    start: String,
    end: String,
) -> Result<String, String> {
    let m365 = settings.m365_path.clone();
    let body = json!({
        "subject": subject,
        "startDateTime": start,
        "endDateTime": end,
    })
    .to_string();
    match graph_write(
        &m365,
        "",
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
// M365 actions (default app scopes: Mail.Send, Tasks.ReadWrite, Chat.ReadWrite)
// ---------------------------------------------------------------------------

async fn graph_get(m365: &str, url: &str) -> Result<String, String> {
    let args = vec![
        "request".to_string(),
        "--url".to_string(),
        url.to_string(),
        "--output".to_string(),
        "json".to_string(),
    ];
    run_m365(m365, "", &args).await
}

fn recipients(list: &[String]) -> Vec<Value> {
    list.iter()
        .filter(|a| a.contains('@'))
        .map(|a| json!({ "emailAddress": { "address": a } }))
        .collect()
}

/// Send an email on Andres' behalf. CONFIRM recipients + content first.
#[tauri::command]
pub async fn send_email(
    to: Vec<String>,
    subject: String,
    body: String,
    cc: Option<Vec<String>>,
    state: State<'_, SettingsState>,
) -> Result<String, String> {
    let s = { state.0.lock().unwrap().clone() };
    if use_daemon(&s) {
        return proxy(&s, "/mail/send", json!({ "to": to, "subject": subject, "body": body, "cc": cc })).await;
    }
    send_email_core(&s, to, subject, body, cc).await
}

pub async fn send_email_core(
    settings: &Settings,
    to: Vec<String>,
    subject: String,
    body: String,
    cc: Option<Vec<String>>,
) -> Result<String, String> {
    let m365 = settings.m365_path.clone();
    let msg = json!({
        "message": {
            "subject": subject,
            "body": { "contentType": "HTML", "content": body },
            "toRecipients": recipients(&to),
            "ccRecipients": cc.as_deref().map(recipients).unwrap_or_default(),
        },
        "saveToSentItems": true
    });
    match graph_write(&m365, "", "post", "https://graph.microsoft.com/v1.0/me/sendMail", Some(msg.to_string())).await {
        Ok(_) => Ok(format!("Email \"{subject}\" sent to {}.", to.join(", "))),
        Err(e) => Ok(permission_hint(&e)),
    }
}

/// Add a reminder/task to Microsoft To Do. `due`/`remind_at` are local ISO datetimes.
#[tauri::command]
pub async fn create_reminder(
    title: String,
    due: Option<String>,
    remind_at: Option<String>,
    state: State<'_, SettingsState>,
) -> Result<String, String> {
    let s = { state.0.lock().unwrap().clone() };
    if use_daemon(&s) {
        return proxy(&s, "/reminder/create", json!({ "title": title, "due": due, "remind_at": remind_at })).await;
    }
    create_reminder_core(&s, title, due, remind_at).await
}

pub async fn create_reminder_core(
    settings: &Settings,
    title: String,
    due: Option<String>,
    remind_at: Option<String>,
) -> Result<String, String> {
    let m365 = settings.m365_path.clone();
    let lists = match graph_get(&m365, "https://graph.microsoft.com/v1.0/me/todo/lists").await {
        Ok(s) => s,
        Err(e) => return Ok(permission_hint(&e)),
    };
    let v: Value = serde_json::from_str(&lists).unwrap_or(Value::Null);
    let arr = v.get("value").and_then(|a| a.as_array()).cloned().unwrap_or_default();
    let list_id = arr
        .iter()
        .find(|l| l.get("wellknownListName").and_then(|w| w.as_str()) == Some("defaultList"))
        .or_else(|| arr.first())
        .and_then(|l| l.get("id"))
        .and_then(|x| x.as_str())
        .unwrap_or("");
    if list_id.is_empty() {
        return Ok("Couldn't find a To Do list to add the reminder to.".into());
    }
    let mut task = json!({ "title": title });
    if let Some(d) = due {
        task["dueDateTime"] = json!({ "dateTime": d, "timeZone": "Central Standard Time" });
    }
    if let Some(r) = remind_at {
        task["reminderDateTime"] = json!({ "dateTime": r, "timeZone": "Central Standard Time" });
        task["isReminderOn"] = json!(true);
    }
    let url = format!("https://graph.microsoft.com/v1.0/me/todo/lists/{list_id}/tasks");
    match graph_write(&m365, "", "post", &url, Some(task.to_string())).await {
        Ok(_) => Ok(format!("Reminder added: {title}")),
        Err(e) => Ok(permission_hint(&e)),
    }
}

/// Send a 1:1 Microsoft Teams chat message. CONFIRM recipient + message first.
#[tauri::command]
pub async fn send_teams_message(
    recipient_email: String,
    message: String,
    state: State<'_, SettingsState>,
) -> Result<String, String> {
    let s = { state.0.lock().unwrap().clone() };
    if use_daemon(&s) {
        return proxy(&s, "/teams/message", json!({ "recipient_email": recipient_email, "message": message })).await;
    }
    send_teams_message_core(&s, recipient_email, message).await
}

pub async fn send_teams_message_core(
    settings: &Settings,
    recipient_email: String,
    message: String,
) -> Result<String, String> {
    let m365 = settings.m365_path.clone();
    let me = match graph_get(&m365, "https://graph.microsoft.com/v1.0/me?$select=id").await {
        Ok(s) => s,
        Err(e) => return Ok(permission_hint(&e)),
    };
    let my_id = serde_json::from_str::<Value>(&me)
        .ok()
        .and_then(|v| v.get("id").and_then(|x| x.as_str()).map(String::from))
        .unwrap_or_default();
    if my_id.is_empty() {
        return Ok("Couldn't resolve your Teams user id.".into());
    }
    let chat_body = json!({
        "chatType": "oneOnOne",
        "members": [
            { "@odata.type": "#microsoft.graph.aadUserConversationMember", "roles": ["owner"],
              "user@odata.bind": format!("https://graph.microsoft.com/v1.0/users('{my_id}')") },
            { "@odata.type": "#microsoft.graph.aadUserConversationMember", "roles": ["owner"],
              "user@odata.bind": format!("https://graph.microsoft.com/v1.0/users('{recipient_email}')") }
        ]
    });
    let chat = match graph_write(&m365, "", "post", "https://graph.microsoft.com/v1.0/chats", Some(chat_body.to_string())).await {
        Ok(s) => s,
        Err(e) => return Ok(permission_hint(&e)),
    };
    let chat_id = serde_json::from_str::<Value>(&chat)
        .ok()
        .and_then(|v| v.get("id").and_then(|x| x.as_str()).map(String::from))
        .unwrap_or_default();
    if chat_id.is_empty() {
        return Ok("Couldn't open a Teams chat with that person.".into());
    }
    let url = format!("https://graph.microsoft.com/v1.0/chats/{chat_id}/messages");
    let msg = json!({ "body": { "content": message } });
    match graph_write(&m365, "", "post", &url, Some(msg.to_string())).await {
        Ok(_) => Ok(format!("Teams message sent to {recipient_email}.")),
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
    let s = { state.0.lock().unwrap().clone() };
    if use_daemon(&s) {
        return proxy(&s, "/web/search", json!({ "query": query })).await;
    }
    web_search_core(&s, query).await
}

pub async fn web_search_core(
    settings: &Settings,
    query: String,
) -> Result<String, String> {
    let key = settings.brave_api_key.clone();
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

/// Read the most recent inbox emails (sender, subject, date, preview).
#[tauri::command]
pub async fn read_emails(
    count: Option<u32>,
    state: State<'_, SettingsState>,
) -> Result<String, String> {
    let s = { state.0.lock().unwrap().clone() };
    if use_daemon(&s) {
        return proxy(&s, "/mail/read", json!({ "count": count })).await;
    }
    read_emails_core(&s, count).await
}

pub async fn read_emails_core(
    settings: &Settings,
    count: Option<u32>,
) -> Result<String, String> {
    let m365 = settings.m365_path.clone();
    let n = count.unwrap_or(10).clamp(1, 25);
    let url = format!(
        "https://graph.microsoft.com/v1.0/me/messages?$top={n}&$select=subject,from,receivedDateTime,bodyPreview,isRead&$orderby=receivedDateTime%20desc"
    );
    let stdout = match graph_get(&m365, &url).await {
        Ok(s) => s,
        Err(e) => return Ok(permission_hint(&e)),
    };
    let v: Value = serde_json::from_str(&stdout).unwrap_or(Value::Null);
    let msgs = v.get("value").and_then(|a| a.as_array()).cloned().unwrap_or_default();
    if msgs.is_empty() {
        return Ok("No emails found in the inbox.".into());
    }
    let mut out = format!("Most recent {} inbox emails (newest first):\n\n", msgs.len());
    for m in &msgs {
        let subj = m.get("subject").and_then(|v| v.as_str()).unwrap_or("(no subject)");
        let fname = m
            .get("from")
            .and_then(|f| f.get("emailAddress"))
            .and_then(|e| e.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let faddr = m
            .get("from")
            .and_then(|f| f.get("emailAddress"))
            .and_then(|e| e.get("address"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let date = m.get("receivedDateTime").and_then(|v| v.as_str()).unwrap_or("");
        let unread = !m.get("isRead").and_then(|v| v.as_bool()).unwrap_or(true);
        let preview: String = m
            .get("bodyPreview")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .chars()
            .take(220)
            .collect();
        out.push_str(&format!(
            "• {}From: {fname} <{faddr}> — {subj}  ({date})\n  {}\n\n",
            if unread { "[UNREAD] " } else { "" },
            preview.replace('\n', " ")
        ));
    }
    Ok(out)
}

/// Fetch ONE specific email's full body + the links inside it. `query` matches a
/// sender, subject, or keyword; the most recent match is returned. This is what
/// lets the assistant actually read links in an email (read_emails only previews).
#[tauri::command]
pub async fn email_details(
    query: String,
    state: State<'_, SettingsState>,
) -> Result<String, String> {
    let s = { state.0.lock().unwrap().clone() };
    if use_daemon(&s) {
        return proxy(&s, "/mail/details", json!({ "query": query })).await;
    }
    email_details_core(&s, query).await
}

pub async fn email_details_core(
    settings: &Settings,
    query: String,
) -> Result<String, String> {
    let m365 = settings.m365_path.clone();
    let q = query.replace('"', "").replace('\\', "");
    // $search ranks by relevance, not date, so pull several and pick the newest.
    let url = format!(
        "https://graph.microsoft.com/v1.0/me/messages?$search=\"{q}\"&$top=10&$select=subject,from,receivedDateTime,body,webLink"
    );
    let stdout = match graph_get(&m365, &url).await {
        Ok(s) => s,
        Err(e) => return Ok(permission_hint(&e)),
    };
    let v: Value = serde_json::from_str(&stdout).unwrap_or(Value::Null);
    let msgs = v.get("value").and_then(|a| a.as_array()).cloned().unwrap_or_default();
    let best = msgs.into_iter().max_by(|a, b| {
        let da = a.get("receivedDateTime").and_then(|v| v.as_str()).unwrap_or("");
        let db = b.get("receivedDateTime").and_then(|v| v.as_str()).unwrap_or("");
        da.cmp(db)
    });
    let m = match best {
        Some(m) => m,
        None => return Ok(format!("No email found matching \"{query}\".")),
    };

    let subj = m.get("subject").and_then(|v| v.as_str()).unwrap_or("(no subject)");
    let fname = m
        .get("from")
        .and_then(|f| f.get("emailAddress"))
        .and_then(|e| e.get("name"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let faddr = m
        .get("from")
        .and_then(|f| f.get("emailAddress"))
        .and_then(|e| e.get("address"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let date = m.get("receivedDateTime").and_then(|v| v.as_str()).unwrap_or("");
    let html = m
        .get("body")
        .and_then(|b| b.get("content"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let links = extract_links(html);
    let links_block = if links.is_empty() {
        "Links found: (none)\n".to_string()
    } else {
        let mut s = String::from("Links found:\n");
        for (i, l) in links.iter().take(12).enumerate() {
            s.push_str(&format!("{}. {}\n", i + 1, l));
        }
        s
    };
    let body_text: String = html_to_text(html).chars().take(2500).collect();

    Ok(format!(
        "Email: {subj}\nFrom: {fname} <{faddr}>\nDate: {date}\n\n{links_block}\nBody:\n{body_text}"
    ))
}

/// Extract http(s) hyperlinks from email HTML, decoding entities, dropping image/
/// asset URLs, and de-duplicating — so the model sees real destination links.
fn extract_links(html: &str) -> Vec<String> {
    let mut seen = std::collections::BTreeSet::new();
    let mut links = vec![];
    for part in html.split("href=").skip(1) {
        let p = part.trim_start();
        let mut chars = p.chars();
        let quote = match chars.next() {
            Some(c @ '"') | Some(c @ '\'') => c,
            _ => continue,
        };
        if let Some(end) = p[1..].find(quote) {
            let raw = &p[1..1 + end];
            let url = raw.replace("&amp;", "&").replace("&#43;", "+");
            let url = unwrap_tracker(url);
            let lower = url.to_lowercase();
            let is_asset = [".png", ".jpg", ".jpeg", ".gif", ".svg", ".css", ".webp"]
                .iter()
                .any(|ext| lower.split('?').next().unwrap_or("").ends_with(ext));
            if (url.starts_with("http://") || url.starts_with("https://"))
                && !is_asset
                && seen.insert(url.clone())
            {
                links.push(url);
            }
        }
    }
    links
}

/// Unwrap click-tracker redirect links (e.g. Canva's `trail.canva.com/CL0/<percent-
/// encoded-real-url>/1/…`) to the real destination so the model sees a readable URL.
fn unwrap_tracker(url: String) -> String {
    if let Some(idx) = url.find("/CL0/") {
        let after = &url[idx + 5..];
        let enc = after.split('/').next().unwrap_or(after);
        let dec = percent_decode(enc);
        if dec.starts_with("http") {
            return dec;
        }
    }
    url
}

fn percent_decode(s: &str) -> String {
    fn hex(b: u8) -> Option<u8> {
        match b {
            b'0'..=b'9' => Some(b - b'0'),
            b'a'..=b'f' => Some(b - b'a' + 10),
            b'A'..=b'F' => Some(b - b'A' + 10),
            _ => None,
        }
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(a), Some(b)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(a * 16 + b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

// ---------------------------------------------------------------------------
// fetch_url  ->  read a web page's text locally (no cloud service)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn fetch_url(url: String) -> Result<String, String> {
    let url = if url.starts_with("http://") || url.starts_with("https://") {
        url
    } else {
        format!("https://{url}")
    };
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Macintosh) BrainAvatar/0.1")
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .timeout(StdDuration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("fetch failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {} fetching {url}", resp.status()));
    }
    let is_html = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(|c| c.contains("html"))
        .unwrap_or(true);
    let body = resp.text().await.map_err(|e| e.to_string())?;
    let text = if is_html { html_to_text(&body) } else { body };
    let snippet: String = text.chars().take(9000).collect();
    Ok(format!("Page content of {url}:\n\n{snippet}"))
}

fn starts_with_ci(s: &str, prefix: &str) -> bool {
    let sb = s.as_bytes();
    let pb = prefix.as_bytes();
    sb.len() >= pb.len() && sb[..pb.len()].eq_ignore_ascii_case(pb)
}

fn find_ci(haystack: &str, needle: &str) -> Option<usize> {
    let hb = haystack.as_bytes();
    let nb = needle.as_bytes();
    if nb.is_empty() || hb.len() < nb.len() {
        return None;
    }
    (0..=hb.len() - nb.len()).find(|&i| hb[i..i + nb.len()].eq_ignore_ascii_case(nb))
}

/// Strip HTML to readable text (drops script/style, tags, collapses whitespace).
fn html_to_text(html: &str) -> String {
    let mut out = String::new();
    let mut rest = html;
    while !rest.is_empty() {
        if starts_with_ci(rest, "<script") || starts_with_ci(rest, "<style") {
            let close = if starts_with_ci(rest, "<script") {
                "</script>"
            } else {
                "</style>"
            };
            match find_ci(rest, close) {
                Some(idx) => rest = &rest[idx + close.len()..],
                None => break,
            }
            out.push(' ');
        } else if rest.starts_with('<') {
            match rest.find('>') {
                Some(idx) => {
                    rest = &rest[idx + 1..];
                    out.push(' ');
                }
                None => break,
            }
        } else {
            let idx = rest.find('<').unwrap_or(rest.len());
            out.push_str(&rest[..idx]);
            rest = &rest[idx..];
        }
    }
    let decoded = out
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ");
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}
