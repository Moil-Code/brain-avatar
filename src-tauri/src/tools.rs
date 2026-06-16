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
    let m365 = { state.0.lock().unwrap().m365_path.clone() };
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
        "https://graph.microsoft.com/v1.0/me/calendarView?startDateTime={}&endDateTime={}&$select=subject,start,end,location,organizer,isAllDay&$orderby=start/dateTime&$top=50",
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
    let stdout = run_cli(&m365, &args).await?;
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
        out.push_str(&format!("• {subj}\n  {start} → {end}"));
        if !loc.is_empty() {
            out.push_str(&format!("  @ {loc}"));
        }
        out.push('\n');
    }
    out
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
