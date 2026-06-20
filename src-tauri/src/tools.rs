use crate::config::{augmented_path, Settings, SettingsState};
use chrono::{Duration, Local, Utc};
use serde_json::{json, Value};
use std::time::Duration as StdDuration;
use tauri::{AppHandle, Emitter, State};
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
/// Append one structured line to the tool log so every external boundary call is
/// observable after the fact (`tail -f ~/Library/Logs/brain-avatar-tools.log`).
/// This is the ONE place we intentionally swallow errors: logging must never break
/// a tool. Without this, failures are invisible and the model's paraphrase is the
/// only signal — the root cause of "it breaks and we can't tell why".
pub(crate) fn tool_log(tool: &str, op: &str, target: &str, status: &str, ms: u128, err: Option<&str>) {
    use std::io::Write;
    let line = tool_log_line(&Local::now().to_rfc3339(), tool, op, target, status, ms, err);
    if let Ok(home) = std::env::var("HOME") {
        let path = format!("{home}/Library/Logs/brain-avatar-tools.log");
        let _ = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .and_then(|mut f| f.write_all(line.as_bytes()));
    }
}

/// Pure formatter for one log line (split out so it's unit-testable without I/O).
/// Always valid JSON: control chars escaped, fields bounded.
fn tool_log_line(
    ts: &str,
    tool: &str,
    op: &str,
    target: &str,
    status: &str,
    ms: u128,
    err: Option<&str>,
) -> String {
    let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "'").replace('\n', " ");
    let err_field = err
        .map(|e| format!(",\"err\":\"{}\"", esc(&e.chars().take(300).collect::<String>())))
        .unwrap_or_default();
    format!(
        "{{\"ts\":\"{}\",\"tool\":\"{}\",\"op\":\"{}\",\"target\":\"{}\",\"status\":\"{}\",\"ms\":{},\"ok\":{}{}}}\n",
        esc(ts), esc(tool), esc(op), esc(target), esc(status), ms, err.is_none(), err_field,
    )
}

/// Pull a readable (op, target) label out of m365 CLI args for the log line —
/// e.g. `["request","--url","https://graph…/me/events","--method","post"]`
/// → op "post", target "…/me/events".
fn m365_label(args: &[String]) -> (String, String) {
    let url = args
        .iter()
        .position(|a| a == "--url")
        .and_then(|i| args.get(i + 1))
        // rsplit yields right-to-left, so .next() is the piece AFTER "/v1.0/"
        // (e.g. "me/events") — the endpoint we want to log, not the host prefix.
        .map(|s| s.rsplit("/v1.0/").next().unwrap_or(s).to_string())
        .unwrap_or_default();
    let method = args
        .iter()
        .position(|a| a == "--method")
        .and_then(|i| args.get(i + 1))
        .cloned()
        .or_else(|| args.first().cloned())
        .unwrap_or_else(|| "?".into());
    (method, url)
}

async fn run_m365(m365: &str, app_id: &str, args: &[String]) -> Result<String, String> {
    let started = std::time::Instant::now();
    let (op, target) = m365_label(args);
    let mut cmd = Command::new(m365);
    cmd.args(args)
        .env("PATH", augmented_path())
        .kill_on_drop(true);
    if !app_id.trim().is_empty() {
        cmd.env("CLIMICROSOFT365_ENTRAAPPID", app_id);
    }
    let outcome = timeout(CLI_TIMEOUT, cmd.output()).await;
    let ms = started.elapsed().as_millis();
    match outcome {
        Err(_) => {
            tool_log("m365", &op, &target, "timeout", ms, Some("CLI timed out"));
            Err("m365 timed out".to_string())
        }
        Ok(Err(e)) => {
            let msg = format!("failed to spawn m365: {e}");
            tool_log("m365", &op, &target, "spawn_error", ms, Some(&msg));
            Err(msg)
        }
        Ok(Ok(out)) if out.status.success() => {
            tool_log("m365", &op, &target, "ok", ms, None);
            Ok(String::from_utf8_lossy(&out.stdout).to_string())
        }
        Ok(Ok(out)) => {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            tool_log(
                "m365",
                &op,
                &target,
                &format!("exit_{}", out.status.code().unwrap_or(-1)),
                ms,
                Some(&stderr),
            );
            Err(format!("{}: {}", out.status, stderr))
        }
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

/// Turn a raw Graph/m365 error into an accurate, actionable message — WITHOUT
/// guessing. Only the access-denied branch asserts a cause (verified by the error
/// code); everything else surfaces the real error so we never send the user chasing
/// the wrong fix (the old version blamed "register the Entra app" for any 403).
fn permission_hint(err: &str) -> String {
    let lower = err.to_lowercase();
    let raw = err.chars().take(220).collect::<String>();
    if err.contains("403")
        || lower.contains("forbidden")
        || lower.contains("erroraccessdenied")
        || lower.contains("access is denied")
    {
        format!(
            "Microsoft denied this write (403): the active m365 login is missing the required \
             Calendars.ReadWrite scope (it has Calendars.Read, so reads work but writes don't). \
             Fix: grant Calendars.ReadWrite on the Entra app, then re-consent — \
             `m365 logout && m365 login`. (raw: {raw})"
        )
    } else if lower.contains("not connected")
        || lower.contains("log in")
        || lower.contains("login")
        || lower.contains("token")
    {
        format!("Not signed in to Microsoft 365 — run `m365 login`, then retry. (raw: {raw})")
    } else {
        format!("Microsoft Graph request failed: {raw}")
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
///
/// NON-IDEMPOTENT: each call creates a new event, so a retry duplicates it. Do not
/// wrap this in automatic retries (same for send_email / send_teams_message).
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

/// Read UNREAD Microsoft Teams chat messages (topic, sender, preview, time).
#[tauri::command]
pub async fn read_teams(
    count: Option<u32>,
    state: State<'_, SettingsState>,
) -> Result<String, String> {
    let s = { state.0.lock().unwrap().clone() };
    if use_daemon(&s) {
        return proxy(&s, "/teams/unread", json!({ "count": count })).await;
    }
    read_teams_core(&s, count).await
}

pub async fn read_teams_core(
    settings: &Settings,
    count: Option<u32>,
) -> Result<String, String> {
    let m365 = settings.m365_path.clone();
    let n = count.unwrap_or(20).clamp(1, 50);
    // Recent chats + last-message preview + the read viewpoint. A chat is UNREAD when
    // its last message is strictly newer than viewpoint.lastMessageReadDateTime.
    let url = format!(
        "https://graph.microsoft.com/v1.0/me/chats?$expand=lastMessagePreview&$top={n}"
    );
    let stdout = match graph_get(&m365, &url).await {
        Ok(s) => s,
        Err(e) => return Ok(permission_hint(&e)),
    };
    let v: Value = serde_json::from_str(&stdout).unwrap_or(Value::Null);
    let chats = v.get("value").and_then(|a| a.as_array()).cloned().unwrap_or_default();
    let mut unread: Vec<(String, String, String, String)> = Vec::new();
    for c in &chats {
        let lmp = c.get("lastMessagePreview");
        let last_dt = lmp
            .and_then(|p| p.get("createdDateTime"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let read_dt = c
            .get("viewpoint")
            .and_then(|vp| vp.get("lastMessageReadDateTime"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if last_dt.is_empty() || read_dt.is_empty() || last_dt <= read_dt {
            continue;
        }
        let body_raw = lmp
            .and_then(|p| p.get("body"))
            .and_then(|b| b.get("content"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        // Skip Teams system events (joined/left/renamed) — not real messages.
        if body_raw.contains("<systemEventMessage") {
            continue;
        }
        let from = lmp
            .and_then(|p| p.get("from"))
            .and_then(|f| f.get("user"))
            .and_then(|u| u.get("displayName"))
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown");
        let topic = c
            .get("topic")
            .and_then(|v| v.as_str())
            .filter(|t| !t.is_empty())
            .unwrap_or("direct/group chat");
        let text = html_to_text(body_raw);
        let text = if text.trim().is_empty() {
            "(attachment or non-text content)".to_string()
        } else {
            text
        };
        unread.push((topic.to_string(), from.to_string(), text, last_dt.to_string()));
    }
    if unread.is_empty() {
        return Ok("No unread Teams chat messages.".into());
    }
    unread.sort_by(|a, b| b.3.cmp(&a.3)); // newest first
    let mut out = format!("You have {} unread Teams chat(s) (newest first):\n\n", unread.len());
    for (topic, from, text, dt) in &unread {
        let preview: String = text.chars().take(220).collect();
        let when = dt.get(..16).unwrap_or(dt.as_str());
        out.push_str(&format!(
            "• [{topic}] {from} ({when}):\n  {}\n\n",
            preview.replace('\n', " ")
        ));
    }
    Ok(out)
}

pub async fn read_emails_core(
    settings: &Settings,
    count: Option<u32>,
) -> Result<String, String> {
    let m365 = settings.m365_path.clone();
    let n = count.unwrap_or(10).clamp(1, 25);
    // INBOX ONLY. /me/messages spans every folder (Sent, Deleted, …) so Andres'
    // own sent mail leaks in; /me/mailFolders/inbox/messages is the actual inbox.
    let url = format!(
        "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top={n}&$select=subject,from,receivedDateTime,bodyPreview,isRead,hasAttachments&$orderby=receivedDateTime%20desc"
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
        let has_att = m.get("hasAttachments").and_then(|v| v.as_bool()).unwrap_or(false);
        let preview: String = m
            .get("bodyPreview")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .chars()
            .take(220)
            .collect();
        out.push_str(&format!(
            "• {}{}From: {fname} <{faddr}> — {subj}  ({date})\n  {}\n\n",
            if unread { "[UNREAD] " } else { "" },
            if has_att { "📎 " } else { "" },
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
    let candidates = match find_messages_by_query(settings, &query).await {
        Ok(c) => c,
        Err(e) => return Ok(permission_hint(&e)),
    };
    if candidates.is_empty() {
        return Ok(format!("No email found matching \"{query}\"."));
    }
    let m = &candidates[0];

    let subj = m.get("subject").and_then(|v| v.as_str()).unwrap_or("(no subject)");
    let (fname, faddr) = from_name_addr(m);
    let date = received_of(m);
    let html = m
        .get("body")
        .and_then(|b| b.get("content"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    // If the real content is in an attachment (the common case for shared docs),
    // tell the model so it follows up with read_attachment instead of guessing.
    let attach_hint = if m.get("hasAttachments").and_then(|v| v.as_bool()).unwrap_or(false) {
        format!(
            "\n📎 This email has attachments — call read_attachment (query \"{query}\") to read them.\n"
        )
    } else {
        String::new()
    };

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

    // Surface a few other matches so the model can self-correct if it picked wrong.
    let mut alts = String::new();
    if candidates.len() > 1 {
        alts.push_str("\nOther recent matches:\n");
        for o in candidates.iter().skip(1).take(3) {
            let (n, _) = from_name_addr(o);
            alts.push_str(&format!(
                "- {} | {} | {}\n",
                received_of(o),
                n,
                o.get("subject").and_then(|v| v.as_str()).unwrap_or("")
            ));
        }
    }

    Ok(format!(
        "Email: {subj}\nFrom: {fname} <{faddr}>\nDate: {date}\n{attach_hint}\n{links_block}\nBody:\n{body_text}\n{alts}"
    ))
}

// ---------------------------------------------------------------------------
// Email attachments + reply + triage (Phase 1: parity with richer mail agents).
// All resolve their target message through find_messages_by_query, so the model
// passes a natural-language `query` (sender/subject), never a raw Graph id.
// ---------------------------------------------------------------------------

/// List the attachments on the email best matching `query` (name, type, size).
pub async fn list_attachments_core(settings: &Settings, query: String) -> Result<String, String> {
    let m365 = &settings.m365_path;
    let candidates = match find_messages_by_query(settings, &query).await {
        Ok(c) => c,
        Err(e) => return Ok(permission_hint(&e)),
    };
    let m = match candidates.first() {
        Some(m) => m,
        None => return Ok(format!("No email found matching \"{query}\".")),
    };
    let id = m.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let subj = m.get("subject").and_then(|v| v.as_str()).unwrap_or("(no subject)");
    if id.is_empty() {
        return Ok("Couldn't resolve that email's id.".into());
    }
    let url = format!(
        "https://graph.microsoft.com/v1.0/me/messages/{id}/attachments?$select=id,name,contentType,size"
    );
    let stdout = match graph_get(m365, &url).await {
        Ok(s) => s,
        Err(e) => return Ok(permission_hint(&e)),
    };
    let v: Value = serde_json::from_str(&stdout).unwrap_or(Value::Null);
    let atts = v.get("value").and_then(|a| a.as_array()).cloned().unwrap_or_default();
    if atts.is_empty() {
        return Ok(format!("\"{subj}\" has no attachments."));
    }
    let mut out = format!("Attachments on \"{subj}\":\n");
    for a in &atts {
        let name = a.get("name").and_then(|v| v.as_str()).unwrap_or("(unnamed)");
        let ct = a.get("contentType").and_then(|v| v.as_str()).unwrap_or("");
        let kb = a.get("size").and_then(|v| v.as_u64()).unwrap_or(0) / 1024;
        out.push_str(&format!("• {name}  ({ct}, {kb} KB)\n"));
    }
    out.push_str("\nUse read_attachment with the email query and the attachment name to read one.");
    Ok(out)
}

/// Read ONE attachment's text from the email matching `query`. `name` picks which
/// attachment (substring match); omitted = the first readable file attachment.
/// Runs the bytes through the shared document pipeline (Word/PDF/RTF/HTML/text).
pub async fn read_attachment_core(
    settings: &Settings,
    query: String,
    name: Option<String>,
) -> Result<String, String> {
    let m365 = &settings.m365_path;
    let candidates = match find_messages_by_query(settings, &query).await {
        Ok(c) => c,
        Err(e) => return Ok(permission_hint(&e)),
    };
    let m = match candidates.first() {
        Some(m) => m,
        None => return Ok(format!("No email found matching \"{query}\".")),
    };
    let id = m.get("id").and_then(|v| v.as_str()).unwrap_or("");
    if id.is_empty() {
        return Ok("Couldn't resolve that email's id.".into());
    }
    // Fetch attachments WITH contentBytes (one call; fine for typical documents).
    let url = format!("https://graph.microsoft.com/v1.0/me/messages/{id}/attachments");
    let stdout = match graph_get(m365, &url).await {
        Ok(s) => s,
        Err(e) => return Ok(permission_hint(&e)),
    };
    let v: Value = serde_json::from_str(&stdout).unwrap_or(Value::Null);
    let atts = v.get("value").and_then(|a| a.as_array()).cloned().unwrap_or_default();
    let is_file = |a: &Value| {
        a.get("@odata.type")
            .and_then(|t| t.as_str())
            .map(|t| t.contains("fileAttachment"))
            .unwrap_or(false)
            && !a.get("isInline").and_then(|v| v.as_bool()).unwrap_or(false)
    };
    let want = name.as_deref().map(|s| s.to_lowercase());
    let chosen = atts.iter().find(|a| {
        if !is_file(a) {
            return false;
        }
        match &want {
            Some(w) => a
                .get("name")
                .and_then(|v| v.as_str())
                .map(|n| n.to_lowercase().contains(w))
                .unwrap_or(false),
            None => true,
        }
    });
    let att = match chosen {
        Some(a) => a,
        None if name.is_some() => {
            return Ok(format!(
                "No readable attachment named like \"{}\" on that email.",
                name.unwrap_or_default()
            ))
        }
        None => return Ok("That email has no readable file attachment.".into()),
    };
    let att_name = att.get("name").and_then(|v| v.as_str()).unwrap_or("attachment");
    let bytes_b64 = match att.get("contentBytes").and_then(|v| v.as_str()) {
        Some(b) => b,
        None => {
            return Ok(format!(
                "\"{att_name}\" can't be read as a document (it may be an inline item or a link)."
            ))
        }
    };
    match crate::files::extract_bytes_text(att_name, bytes_b64, 15000).await {
        Ok(text) => Ok(format!("Attachment \"{att_name}\":\n\n{text}")),
        Err(e) => Ok(format!("Couldn't read \"{att_name}\": {e}")),
    }
}

/// Reply (or reply-all) in-thread to the email matching `query`. Sends from the
/// signed-in mailbox. Confirm the recipient/content with Andres before calling.
pub async fn reply_email_core(
    settings: &Settings,
    query: String,
    body: String,
    reply_all: Option<bool>,
) -> Result<String, String> {
    let candidates = match find_messages_by_query(settings, &query).await {
        Ok(c) => c,
        Err(e) => return Ok(permission_hint(&e)),
    };
    let m = match candidates.first() {
        Some(m) => m,
        None => return Ok(format!("No email found matching \"{query}\".")),
    };
    let id = m.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let subj = m.get("subject").and_then(|v| v.as_str()).unwrap_or("(no subject)");
    let (fname, _) = from_name_addr(m);
    if id.is_empty() {
        return Ok("Couldn't resolve that email's id.".into());
    }
    let action = if reply_all.unwrap_or(false) { "replyAll" } else { "reply" };
    let url = format!("https://graph.microsoft.com/v1.0/me/messages/{id}/{action}");
    let payload = json!({ "comment": body });
    match graph_write(
        &settings.m365_path,
        &settings.m365_app_id,
        "post",
        &url,
        Some(payload.to_string()),
    )
    .await
    {
        Ok(_) => Ok(format!("Replied to {fname} on \"{subj}\".")),
        Err(e) => Ok(permission_hint(&e)),
    }
}

/// Triage the email matching `query`: mark_read, mark_unread, flag, unflag,
/// archive, or delete (delete = move to Deleted Items). Mutating actions need the
/// Mail.ReadWrite scope; a permission error explains how to grant it.
pub async fn email_action_core(
    settings: &Settings,
    query: String,
    action: String,
) -> Result<String, String> {
    let candidates = match find_messages_by_query(settings, &query).await {
        Ok(c) => c,
        Err(e) => return Ok(permission_hint(&e)),
    };
    let m = match candidates.first() {
        Some(m) => m,
        None => return Ok(format!("No email found matching \"{query}\".")),
    };
    let id = m.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let subj = m.get("subject").and_then(|v| v.as_str()).unwrap_or("(no subject)");
    if id.is_empty() {
        return Ok("Couldn't resolve that email's id.".into());
    }
    let base = format!("https://graph.microsoft.com/v1.0/me/messages/{id}");
    let act = action.trim().to_lowercase();
    let (method, url, payload): (&str, String, Option<String>) = match act.as_str() {
        "mark_read" | "read" => ("patch", base.clone(), Some(json!({ "isRead": true }).to_string())),
        "mark_unread" | "unread" => {
            ("patch", base.clone(), Some(json!({ "isRead": false }).to_string()))
        }
        "flag" => (
            "patch",
            base.clone(),
            Some(json!({ "flag": { "flagStatus": "flagged" } }).to_string()),
        ),
        "unflag" => (
            "patch",
            base.clone(),
            Some(json!({ "flag": { "flagStatus": "notFlagged" } }).to_string()),
        ),
        "archive" => (
            "post",
            format!("{base}/move"),
            Some(json!({ "destinationId": "archive" }).to_string()),
        ),
        "delete" | "trash" => (
            "post",
            format!("{base}/move"),
            Some(json!({ "destinationId": "deleteditems" }).to_string()),
        ),
        other => {
            return Ok(format!(
                "Unknown email action '{other}'. Use: mark_read, mark_unread, flag, unflag, archive, delete."
            ))
        }
    };
    match graph_write(&settings.m365_path, &settings.m365_app_id, method, &url, payload).await {
        Ok(_) => Ok(format!("Done — {act} on \"{subj}\".")),
        Err(e) => Ok(permission_hint(&e)),
    }
}

#[tauri::command]
pub async fn list_attachments(
    query: String,
    state: State<'_, SettingsState>,
) -> Result<String, String> {
    let s = { state.0.lock().unwrap().clone() };
    if use_daemon(&s) {
        return proxy(&s, "/mail/attachments", json!({ "query": query })).await;
    }
    list_attachments_core(&s, query).await
}

#[tauri::command]
pub async fn read_attachment(
    query: String,
    name: Option<String>,
    state: State<'_, SettingsState>,
) -> Result<String, String> {
    let s = { state.0.lock().unwrap().clone() };
    if use_daemon(&s) {
        return proxy(&s, "/mail/attachment", json!({ "query": query, "name": name })).await;
    }
    read_attachment_core(&s, query, name).await
}

#[tauri::command]
pub async fn reply_email(
    query: String,
    body: String,
    reply_all: Option<bool>,
    state: State<'_, SettingsState>,
) -> Result<String, String> {
    let s = { state.0.lock().unwrap().clone() };
    if use_daemon(&s) {
        return proxy(&s, "/mail/reply", json!({ "query": query, "body": body, "reply_all": reply_all })).await;
    }
    reply_email_core(&s, query, body, reply_all).await
}

#[tauri::command]
pub async fn email_action(
    query: String,
    action: String,
    state: State<'_, SettingsState>,
) -> Result<String, String> {
    let s = { state.0.lock().unwrap().clone() };
    if use_daemon(&s) {
        return proxy(&s, "/mail/action", json!({ "query": query, "action": action })).await;
    }
    email_action_core(&s, query, action).await
}

/// Run a Graph mail `$search` and return the matched messages. Includes `id` and
/// `hasAttachments` so callers can act on a specific message (attachments, reply,
/// triage) without the model juggling opaque ids.
async fn search_messages(m365: &str, search: &str, top: u32) -> Result<Vec<Value>, String> {
    let url = format!(
        "https://graph.microsoft.com/v1.0/me/messages?$search=\"{search}\"&$top={top}&$select=id,subject,from,receivedDateTime,body,webLink,hasAttachments"
    );
    let stdout = graph_get(m365, &url).await?;
    let v: Value = serde_json::from_str(&stdout).unwrap_or(Value::Null);
    Ok(v.get("value").and_then(|a| a.as_array()).cloned().unwrap_or_default())
}

/// Find the messages best matching a natural-language `query` (sender, subject, or
/// keyword), newest first — the same ranking email_details uses: sender-scoped
/// search first, then a general keyword search with the user's own self-sent
/// "briefing" mail filtered out. Returns [] when nothing matches. The attachment,
/// reply, and triage tools all resolve their target email through this, so the model
/// just says "the email from Monica" instead of passing a raw Graph id.
async fn find_messages_by_query(settings: &Settings, query: &str) -> Result<Vec<Value>, String> {
    let m365 = &settings.m365_path;
    let q = query.replace('"', "").replace('\\', "").trim().to_string();
    let owner = owner_address(m365).await.unwrap_or_default().to_lowercase();
    let from_msgs = search_messages(m365, &format!("from:{q}"), 10).await?;
    let mut candidates = from_msgs;
    if candidates.is_empty() {
        let general = search_messages(m365, &q, 20).await.unwrap_or_default();
        let non_self: Vec<Value> = general
            .iter()
            .filter(|m| from_addr_of(m).to_lowercase() != owner)
            .cloned()
            .collect();
        candidates = if non_self.is_empty() { general } else { non_self };
    }
    candidates.sort_by(|a, b| received_of(b).cmp(received_of(a))); // newest first
    Ok(candidates)
}

/// The signed-in mailbox owner's address (to identify self-sent mail).
async fn owner_address(m365: &str) -> Option<String> {
    let stdout = graph_get(m365, "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName")
        .await
        .ok()?;
    let v: Value = serde_json::from_str(&stdout).ok()?;
    v.get("mail")
        .and_then(|x| x.as_str())
        .or_else(|| v.get("userPrincipalName").and_then(|x| x.as_str()))
        .map(|s| s.to_string())
}

fn from_addr_of(m: &Value) -> String {
    m.get("from")
        .and_then(|f| f.get("emailAddress"))
        .and_then(|e| e.get("address"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}
fn from_name_addr(m: &Value) -> (String, String) {
    let e = m.get("from").and_then(|f| f.get("emailAddress"));
    let n = e
        .and_then(|e| e.get("name"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let a = e
        .and_then(|e| e.get("address"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    (n, a)
}
fn received_of(m: &Value) -> &str {
    m.get("receivedDateTime").and_then(|v| v.as_str()).unwrap_or("")
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

/// Fetch Andres' most recent X (Twitter) bookmarks as JSON (author, text, tweet
/// URL, outbound article links). Reuses the Brain's sanctioned X-API scraper
/// (OAuth2 + refresh) read-only — never writes the daily digest. The model can
/// then fetch_url each link to actually read and summarize a bookmark.
#[tauri::command]
pub async fn x_bookmarks(count: Option<u32>) -> Result<String, String> {
    let n = count.unwrap_or(5).clamp(1, 25);
    let py = "/Users/jarvisurrego/My Brain/pi-workspace/.venv/bin/python3";
    let script = "/Users/jarvisurrego/My Brain/pi-workspace/bin/x-bookmarks-recent.py";
    let args = vec![
        script.to_string(),
        "--count".to_string(),
        n.to_string(),
    ];
    // The script exits 0 and emits JSON even for the not-activated / error cases,
    // so surface its stdout to the model rather than treating it as a hard error.
    match run_cli(py, &args).await {
        Ok(s) if !s.trim().is_empty() => Ok(s),
        Ok(_) => Ok("{\"ok\":false,\"error\":\"x-bookmarks returned no output\"}".to_string()),
        Err(e) => Ok(format!("{{\"ok\":false,\"error\":\"{}\"}}", e.replace('"', "'"))),
    }
}

/// Generate an image locally with Bonsai (MLX ternary 4B diffusion). Runs the
/// existing bonsai wrapper (auto-starting its backend if needed), then emits the
/// PNG as a data URL to the UI via an `image-generated` event and returns a short
/// confirmation to the model (no base64 in the model's context).
#[tauri::command]
pub async fn generate_image(
    app: AppHandle,
    prompt: String,
    size: Option<String>,
    steps: Option<u32>,
) -> Result<String, String> {
    use base64::Engine;
    let home = std::env::var("HOME").unwrap_or_else(|_| "/Users/jarvisurrego".into());
    let script = format!("{home}/OpenClawAgent/workspace/scripts/bonsai_generate_image.sh");
    if !std::path::Path::new(&script).exists() {
        return Ok("Image generation isn't available (Bonsai script not found).".into());
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let out = std::env::temp_dir()
        .join(format!("brain-avatar-gen-{nanos}.png"))
        .to_string_lossy()
        .to_string();
    let size = size.unwrap_or_else(|| "512x512".into());
    let steps = steps.unwrap_or(4).clamp(1, 12).to_string();

    let args = vec![
        script,
        "--prompt".into(),
        prompt.clone(),
        "--out".into(),
        out.clone(),
        "--size".into(),
        size,
        "--steps".into(),
        steps,
    ];
    let mut cmd = Command::new("bash");
    cmd.args(&args)
        .env("PATH", augmented_path())
        .env("BONSAI_AUTOSTART", "1") // start the bonsai backend if it isn't up
        .kill_on_drop(true);
    // Generous: a first run boots the bonsai server + loads the model; warm runs ~15s.
    let res = timeout(StdDuration::from_secs(300), cmd.output())
        .await
        .map_err(|_| "image generation timed out (bonsai backend may be starting)".to_string())?
        .map_err(|e| format!("failed to run bonsai: {e}"))?;
    if !res.status.success() {
        let err = String::from_utf8_lossy(&res.stderr);
        return Ok(format!(
            "Image generation failed: {}",
            err.trim().chars().take(300).collect::<String>()
        ));
    }
    let bytes = match std::fs::read(&out) {
        Ok(b) => b,
        Err(e) => return Ok(format!("Image was generated but couldn't be read: {e}")),
    };
    let data_url = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    );
    let _ = app.emit(
        "image-generated",
        json!({ "dataUrl": data_url, "prompt": prompt, "path": out }),
    );
    Ok(format!(
        "Generated an image for \"{prompt}\" and displayed it above (saved to {out}). Briefly confirm to Andres; do NOT describe the pixels."
    ))
}

/// Post an image to one of Andres' Facebook Pages using the permanent Page Access
/// Tokens in ~/.openclaw/secrets/facebook.env (Graph API — reliable, no browser).
/// `page` = "moil" (Moil by Jarvis) or "jarvis_tx" (Jarvis AI TX). This PUBLISHES
/// publicly, so the model must confirm with Andres before calling.
#[tauri::command]
pub async fn post_to_facebook(
    image_path: String,
    caption: String,
    page: Option<String>,
) -> Result<String, String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/Users/jarvisurrego".into());
    let env_path = format!("{home}/.openclaw/secrets/facebook.env");
    let raw = match std::fs::read_to_string(&env_path) {
        Ok(r) => r,
        Err(_) => return Ok("Facebook isn't configured (facebook.env not found).".into()),
    };
    let mut vars = std::collections::HashMap::new();
    for line in raw.lines() {
        let l = line.trim().trim_start_matches("export ").trim();
        if l.starts_with('#') || !l.contains('=') {
            continue;
        }
        if let Some((k, v)) = l.split_once('=') {
            vars.insert(
                k.trim().to_string(),
                v.trim().trim_matches('"').trim_matches('\'').to_string(),
            );
        }
    }
    let page_key = page.unwrap_or_else(|| "moil".into()).to_lowercase();
    let (token, page_id) = if page_key.contains("jarvis") || page_key.contains("tx") {
        (vars.get("FB_PAGE_TOKEN_JARVIS_TX"), vars.get("FB_PAGE_ID_JARVIS_TX"))
    } else {
        (vars.get("FB_PAGE_TOKEN_MOIL"), vars.get("FB_PAGE_ID_MOIL"))
    };
    let (token, page_id) = match (token, page_id) {
        (Some(t), Some(p)) if !t.is_empty() && !p.is_empty() => (t.clone(), p.clone()),
        _ => return Ok(format!("No Facebook token/page id for '{page_key}' in facebook.env.")),
    };

    let path = std::path::Path::new(&image_path);
    if !path.exists() {
        return Ok(format!("Image not found: {image_path}"));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("read image failed: {e}"))?;
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name("image.png")
        .mime_str("image/png")
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new()
        .text("message", caption)
        .text("access_token", token)
        .part("source", part);

    let url = format!("https://graph.facebook.com/v22.0/{page_id}/photos");
    let resp = reqwest::Client::new()
        .post(&url)
        .multipart(form)
        .timeout(StdDuration::from_secs(60))
        .send()
        .await
        .map_err(|e| format!("Facebook post failed: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Ok(format!(
            "Facebook rejected the post (HTTP {status}): {}",
            body.chars().take(300).collect::<String>()
        ));
    }
    let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    let post_id = v
        .get("post_id")
        .or_else(|| v.get("id"))
        .and_then(|x| x.as_str())
        .unwrap_or("");
    Ok(format!(
        "Posted to the {page_key} Facebook page. Post id {post_id} — https://facebook.com/{post_id}"
    ))
}

/// Load a Facebook Page's (token, page_id, page_key) from ~/.openclaw/secrets/facebook.env.
/// `page` = "moil" (default) or "jarvis_tx". Returns a human message on the Err side
/// so the model can relay it.
fn fb_page_creds(page: Option<String>) -> Result<(String, String, String), String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/Users/jarvisurrego".into());
    let env_path = format!("{home}/.openclaw/secrets/facebook.env");
    let raw = std::fs::read_to_string(&env_path)
        .map_err(|_| "Facebook isn't configured (facebook.env not found).".to_string())?;
    let mut vars = std::collections::HashMap::new();
    for line in raw.lines() {
        let l = line.trim().trim_start_matches("export ").trim();
        if l.starts_with('#') || !l.contains('=') {
            continue;
        }
        if let Some((k, v)) = l.split_once('=') {
            vars.insert(
                k.trim().to_string(),
                v.trim().trim_matches('"').trim_matches('\'').to_string(),
            );
        }
    }
    let page_key = page.unwrap_or_else(|| "moil".into()).to_lowercase();
    let (token, page_id) = if page_key.contains("jarvis") || page_key.contains("tx") {
        (vars.get("FB_PAGE_TOKEN_JARVIS_TX"), vars.get("FB_PAGE_ID_JARVIS_TX"))
    } else {
        (vars.get("FB_PAGE_TOKEN_MOIL"), vars.get("FB_PAGE_ID_MOIL"))
    };
    match (token, page_id) {
        (Some(t), Some(p)) if !t.is_empty() && !p.is_empty() => {
            Ok((t.clone(), p.clone(), page_key))
        }
        _ => Err(format!("No Facebook token/page id for '{page_key}' in facebook.env.")),
    }
}

/// Avatar-side command: in remote mode the Page tokens live on the brain-owner
/// (Mac Mini) where facebook.env is, so proxy there; otherwise read locally.
#[tauri::command]
pub async fn facebook_insights(
    page: Option<String>,
    state: State<'_, SettingsState>,
) -> Result<String, String> {
    let s = { state.0.lock().unwrap().clone() };
    if use_daemon(&s) {
        return proxy(&s, "/facebook/insights", json!({ "page": page })).await;
    }
    facebook_insights_core(page).await
}

/// Read engagement metrics for a Facebook Page (followers, reach, impressions,
/// post engagement) over the last 28 days. Reuses the same Page tokens as
/// post_to_facebook. Reach/engagement insights need the token to carry the
/// `read_insights` permission; if it doesn't, we still report the follower count
/// and explain what's missing so Andres can re-grant.
pub async fn facebook_insights_core(page: Option<String>) -> Result<String, String> {
    let (token, page_id, page_key) = match fb_page_creds(page) {
        Ok(v) => v,
        Err(msg) => return Ok(msg),
    };
    let client = reqwest::Client::new();
    let mut out = format!("Facebook insights — {page_key} page:\n");

    // 1) Basic page totals (name + follower/like counts).
    let prof_url = format!(
        "https://graph.facebook.com/v22.0/{page_id}?fields=name,fan_count,followers_count&access_token={token}"
    );
    if let Ok(resp) = client.get(&prof_url).timeout(StdDuration::from_secs(30)).send().await {
        let v: Value = serde_json::from_str(&resp.text().await.unwrap_or_default()).unwrap_or(Value::Null);
        if let Some(name) = v.get("name").and_then(|x| x.as_str()) {
            out.push_str(&format!("• Page: {name}\n"));
        }
        if let Some(f) = v.get("followers_count").and_then(|x| x.as_u64()) {
            out.push_str(&format!("• Followers: {f}\n"));
        }
        if let Some(f) = v.get("fan_count").and_then(|x| x.as_u64()) {
            out.push_str(&format!("• Page likes: {f}\n"));
        }
    }

    // 2) 28-day insights: unique reach, impressions, post engagements, page views.
    let ins_url = format!(
        "https://graph.facebook.com/v22.0/{page_id}/insights\
         ?metric=page_impressions_unique,page_impressions,page_post_engagements,page_views_total\
         &period=days_28&access_token={token}"
    );
    match client.get(&ins_url).timeout(StdDuration::from_secs(30)).send().await {
        Ok(resp) => {
            let body = resp.text().await.unwrap_or_default();
            let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            if let Some(err) = v.get("error").and_then(|e| e.get("message")).and_then(|m| m.as_str()) {
                out.push_str(&format!(
                    "• (Reach/engagement metrics unavailable: {err}. The Page token may need the \
                     read_insights permission.)\n"
                ));
            } else if let Some(data) = v.get("data").and_then(|d| d.as_array()) {
                fn label(name: &str) -> &str {
                    match name {
                        "page_impressions_unique" => "Reach (people, 28d)",
                        "page_impressions" => "Impressions (28d)",
                        "page_post_engagements" => "Post engagements (28d)",
                        "page_views_total" => "Page views (28d)",
                        other => other,
                    }
                }
                for m in data {
                    let name = m.get("name").and_then(|n| n.as_str()).unwrap_or("");
                    // The latest period entry is the most recent cumulative value.
                    let val = m
                        .get("values")
                        .and_then(|vs| vs.as_array())
                        .and_then(|vs| vs.last())
                        .and_then(|x| x.get("value"))
                        .and_then(|x| x.as_u64());
                    if let Some(val) = val {
                        out.push_str(&format!("• {}: {val}\n", label(name)));
                    }
                }
            }
        }
        Err(e) => out.push_str(&format!("• (Insights request failed: {e})\n")),
    }

    // 3) Recent posts with reach, so "how did my last posts do" works.
    let posts_url = format!(
        "https://graph.facebook.com/v22.0/{page_id}/posts\
         ?fields=message,created_time,insights.metric(post_impressions_unique).as(reach)\
         &limit=5&access_token={token}"
    );
    if let Ok(resp) = client.get(&posts_url).timeout(StdDuration::from_secs(30)).send().await {
        let v: Value = serde_json::from_str(&resp.text().await.unwrap_or_default()).unwrap_or(Value::Null);
        if let Some(posts) = v.get("data").and_then(|d| d.as_array()) {
            if !posts.is_empty() {
                out.push_str("Recent posts:\n");
                for p in posts.iter().take(5) {
                    let when = p.get("created_time").and_then(|x| x.as_str()).unwrap_or("");
                    let date = when.split('T').next().unwrap_or(when);
                    let msg = p
                        .get("message")
                        .and_then(|x| x.as_str())
                        .unwrap_or("(no caption)");
                    let msg_short: String = msg.chars().take(60).collect();
                    let reach = p
                        .get("reach")
                        .and_then(|r| r.get("data"))
                        .and_then(|d| d.as_array())
                        .and_then(|d| d.first())
                        .and_then(|x| x.get("values"))
                        .and_then(|vs| vs.as_array())
                        .and_then(|vs| vs.first())
                        .and_then(|x| x.get("value"))
                        .and_then(|x| x.as_u64());
                    match reach {
                        Some(r) => out.push_str(&format!("  · {date} — \"{msg_short}\" — reach {r}\n")),
                        None => out.push_str(&format!("  · {date} — \"{msg_short}\"\n")),
                    }
                }
            }
        }
    }

    Ok(out)
}

/// Append one chat turn to the cross-machine inbox (~/.brain-chat-inbox/pushed.json,
/// conversations.json-shaped). Runs ON the brain-owner (Mac Mini, via the daemon)
/// so the nightly ingest sees MacBook chats too. Conversation ids are random, so a
/// single file with no per-machine namespacing is collision-safe.
pub async fn push_chat_core(
    conversation_id: String,
    title: String,
    role: String,
    content: String,
) -> Result<String, String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/Users/jarvisurrego".into());
    let dir = std::path::Path::new(&home).join(".brain-chat-inbox");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("pushed.json");
    let mut store: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({ "conversations": [] }));
    let now = Utc::now().to_rfc3339();
    let is_user = role == "user";
    let msg = json!({ "role": role, "content": content, "ts": now });
    let convs = store
        .get_mut("conversations")
        .and_then(|c| c.as_array_mut())
        .ok_or("bad inbox store")?;
    if let Some(c) = convs
        .iter_mut()
        .find(|c| c.get("id").and_then(|x| x.as_str()) == Some(conversation_id.as_str()))
    {
        if is_user && c.get("title").and_then(|t| t.as_str()).unwrap_or("").is_empty() {
            c["title"] = json!(title);
        }
        c["updated_at"] = json!(now);
        if let Some(m) = c.get_mut("messages").and_then(|m| m.as_array_mut()) {
            m.push(msg);
        }
    } else {
        convs.push(json!({
            "id": conversation_id,
            "title": title,
            "created_at": now,
            "updated_at": now,
            "messages": [msg],
        }));
    }
    std::fs::write(
        &path,
        serde_json::to_string_pretty(&store).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok("ok".into())
}

/// Avatar-side: push a chat turn to the brain-daemon so the Mac Mini's nightly
/// ingest captures this client's chats. No-op on the brain owner (no daemon URL).
/// Best-effort — never blocks or fails the chat.
#[tauri::command]
pub async fn push_chat(
    conversation_id: String,
    title: String,
    role: String,
    content: String,
    state: State<'_, SettingsState>,
) -> Result<(), String> {
    let s = { state.0.lock().unwrap().clone() };
    if !use_daemon(&s) {
        return Ok(());
    }
    let body = json!({
        "conversation_id": conversation_id,
        "title": title,
        "role": role,
        "content": content,
    });
    let _ = proxy(&s, "/chat/push", body).await;
    Ok(())
}

/// Delegate a real browser task (login, navigate, read, interact) to the local
/// Browser Agent (Playwright + the 24GB vision model) on :3939. It drives a
/// PERSISTENT Chromium profile, so sites Andres logged into once (via `npm run
/// login`) stay logged in. Use for "log into moilapp.com", "go to my dashboard",
/// "navigate X and read it" — anything fetch_url can't do because it needs a
/// real, authenticated browser session.
#[tauri::command]
pub async fn web_task(
    intent: String,
    state: State<'_, SettingsState>,
) -> Result<String, String> {
    let s = { state.0.lock().unwrap().clone() };
    if use_daemon(&s) {
        // The browser agent (+ Andres' logins) lives on the Mac Mini, so a remote
        // client proxies web tasks to the daemon instead of its own localhost:3939.
        return proxy(&s, "/web/task", json!({ "intent": intent })).await;
    }
    web_task_core(intent).await
}

pub async fn web_task_core(intent: String) -> Result<String, String> {
    let base = std::env::var("BROWSER_AGENT_URL")
        .unwrap_or_else(|_| "http://localhost:3939".into());
    // Browser tasks (Playwright + the 24GB vision model) genuinely take 100–300s —
    // a logged-in Facebook/moilapp navigation is slow. The old 180s ceiling cut the
    // browser agent off mid-run, so the model reported a "connection interrupted"
    // error that wasn't real. Wait past the agent's own ~300s cap so we get its
    // actual result (success OR a clean failure) instead of a client-side timeout.
    let resp = reqwest::Client::new()
        .post(format!("{base}/api/solve"))
        .json(&json!({ "intent": intent }))
        .timeout(StdDuration::from_secs(330))
        .send()
        .await
        .map_err(|e| {
            format!("The browser agent isn't reachable ({e}). It should be running on :3939.")
        })?;
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    if v.get("success").and_then(|s| s.as_bool()).unwrap_or(false) {
        let data = serde_json::to_string(&v.get("data").cloned().unwrap_or(Value::Null))
            .unwrap_or_default();
        Ok(format!(
            "Browser task done. Result: {}",
            data.chars().take(3500).collect::<String>()
        ))
    } else {
        let err = v.get("error").and_then(|e| e.as_str()).unwrap_or("unknown error");
        Ok(format!("Browser task didn't complete: {err}"))
    }
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

// ---------------------------------------------------------------------------
// Tests — PHASE 5 validation: force the error/edge cases and assert graceful,
// accurate output (no panics, valid log JSON, correct remediation per cause).
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_hint_403_names_the_real_scope_not_a_guess() {
        let h = permission_hint("StatusCode(403): {\"error\":{\"code\":\"ErrorAccessDenied\"}}");
        assert!(h.contains("Calendars.ReadWrite"), "should name the missing scope");
        assert!(h.contains("m365 logout"), "should give the re-consent fix");
        assert!(h.contains("raw:"), "should include the raw error, not just a guess");
        // The old misleading remediation must be gone.
        assert!(!h.contains("README"));
    }

    #[test]
    fn permission_hint_not_signed_in_says_login() {
        let h = permission_hint("Error: Not connected to Microsoft 365. Please run login");
        assert!(h.contains("m365 login"));
    }

    #[test]
    fn permission_hint_other_errors_surface_raw_not_a_canned_cause() {
        let h = permission_hint("StatusCode(400): bad request body");
        assert!(h.contains("bad request body"), "must surface the real error");
        assert!(!h.contains("Calendars.ReadWrite"), "must not falsely blame a scope");
    }

    #[test]
    fn tool_log_line_is_valid_json_and_marks_ok() {
        let ok = tool_log_line("2026-06-17T00:00:00Z", "m365", "get", "me/events", "ok", 42, None);
        let v: Value = serde_json::from_str(ok.trim()).expect("ok line must be valid JSON");
        assert_eq!(v["ok"], serde_json::json!(true));
        assert_eq!(v["status"], "ok");
        assert!(v.get("err").is_none());

        let bad = tool_log_line(
            "2026-06-17T00:00:00Z",
            "m365",
            "post",
            "me/events",
            "exit_1",
            1200,
            Some("403 \"Forbidden\"\nmulti-line"),
        );
        let v: Value = serde_json::from_str(bad.trim()).expect("err line must stay valid JSON");
        assert_eq!(v["ok"], serde_json::json!(false));
        assert!(v["err"].as_str().unwrap().contains("403"));
        // newline + embedded quotes must not break the JSON
        assert!(!bad.trim_end().contains('\n'));
    }
}
