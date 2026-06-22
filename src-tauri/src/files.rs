use crate::config::{augmented_path, resolve_bin};
use crate::tools::tool_log;
use std::path::Path;
use std::time::{Duration, Instant};
use tokio::process::Command;
use tokio::time::timeout;

const T: Duration = Duration::from_secs(25);

async fn run(program: &str, args: &[&str]) -> Result<String, String> {
    let out = timeout(
        T,
        Command::new(resolve_bin(program))
            .args(args)
            .env("PATH", augmented_path())
            .output(),
    )
    .await
    .map_err(|_| format!("`{program}` timed out"))?
    .map_err(|e| format!("`{program}` failed: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(format!(
            "`{program}` error: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

/// Like `run`, but returns stdout regardless of exit code. `find`/`mdfind` print
/// valid results AND exit non-zero when some paths are permission-denied (TCC),
/// so we keep whatever they found.
async fn run_lenient(program: &str, args: &[&str]) -> String {
    match timeout(
        T,
        Command::new(resolve_bin(program))
            .args(args)
            .env("PATH", augmented_path())
            .output(),
    )
    .await
    {
        Ok(Ok(out)) => String::from_utf8_lossy(&out.stdout).to_string(),
        _ => String::new(),
    }
}

/// Native recursive filename search. Case-insensitive substring match, bounded
/// depth + work, skips noise and permission-denied dirs (so it works without
/// Full Disk Access for non-protected files, and won't stall on protected ones).
fn walk_find(root: &str, query: &str, max: usize) -> Vec<String> {
    let needle = query.to_lowercase();
    if needle.is_empty() {
        return vec![];
    }
    let mut out: Vec<String> = Vec::new();
    let mut stack: Vec<(std::path::PathBuf, usize)> = vec![(std::path::PathBuf::from(root), 0)];
    let mut visited = 0usize;
    while let Some((dir, depth)) = stack.pop() {
        if out.len() >= max || visited > 15_000 {
            break;
        }
        visited += 1;
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue, // permission-denied / unreadable -> skip
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                if name.starts_with('.') || name == "node_modules" || name == "Library" {
                    continue;
                }
                if depth + 1 <= 4 {
                    stack.push((entry.path(), depth + 1));
                }
            }
            if name.to_lowercase().contains(&needle) {
                out.push(entry.path().to_string_lossy().to_string());
                if out.len() >= max {
                    break;
                }
            }
        }
    }
    out
}

fn expand_home(p: &str) -> String {
    if let Some(rest) = p.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return format!("{home}/{rest}");
        }
    }
    p.to_string()
}

/// Find files by name/content. Tries Spotlight (mdfind, content-aware) first, then
/// falls back to a direct filename `find` (Spotlight is often not indexing key dirs).
#[tauri::command]
pub async fn find_files(query: String, scope: Option<String>) -> Result<String, String> {
    if query.trim().is_empty() {
        return Err("Empty search query".into());
    }
    let dir = expand_home(
        &scope
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| std::env::var("HOME").unwrap_or_else(|_| "/Users".into())),
    );

    // 1) Spotlight (content + name) where indexed.
    let mut paths: Vec<String> = run_lenient("/usr/bin/mdfind", &["-onlyin", &dir, &query])
        .await
        .lines()
        .filter(|l| !l.is_empty())
        .map(|s| s.to_string())
        .collect();

    // 2) Fallback: native filename walk. Uses the same direct file access that
    //    works without Full Disk Access, and skips permission-denied dirs
    //    gracefully (a `find` subprocess stalls on TCC-protected dirs instead).
    if paths.is_empty() {
        let d = dir.clone();
        let q = query.trim().to_string();
        paths = tokio::task::spawn_blocking(move || walk_find(&d, &q, 40))
            .await
            .unwrap_or_default();
    }

    paths.truncate(20);
    if paths.is_empty() {
        return Ok(format!("No files found matching \"{query}\" under {dir}."));
    }
    let mut s = format!("Files matching \"{query}\" (top {}):\n", paths.len());
    for p in &paths {
        let name = Path::new(p).file_name().and_then(|n| n.to_str()).unwrap_or(p);
        s.push_str(&format!("• {name}\n    {p}\n"));
    }
    Ok(s)
}

/// Read a file's text content (plain text, Markdown, Word/RTF/HTML via textutil,
/// PDF via pdftotext if installed). Read-only.
#[tauri::command]
pub async fn read_file(path: String, max_chars: Option<usize>) -> Result<String, String> {
    let path = expand_home(&path);
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("File not found: {path}"));
    }
    let cap = max_chars.unwrap_or(8000);
    let text = extract_text(&path, cap).await?;
    Ok(format!("Contents of {path}:\n\n{text}"))
}

/// Extract readable text from a file at `path`, capped to `cap` characters.
async fn extract_text(path: &str, cap: usize) -> Result<String, String> {
    let p = Path::new(path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let text = match ext.as_str() {
        "txt" | "md" | "markdown" | "text" | "csv" | "tsv" | "json" | "log" | "yaml" | "yml"
        | "toml" | "xml" | "" => {
            std::fs::read_to_string(p).map_err(|e| format!("read failed: {e}"))?
        }
        "rtf" | "rtfd" | "doc" | "docx" | "html" | "htm" | "odt" | "webarchive" => {
            run("/usr/bin/textutil", &["-convert", "txt", "-stdout", &path]).await?
        }
        "pdf" => match run("pdftotext", &[&path, "-"]).await {
            Ok(t) => t,
            Err(_) => {
                return Ok(format!(
                    "\"{path}\" is a PDF. Install pdftotext (`brew install poppler`) to read PDFs aloud, or I can open it for you instead."
                ))
            }
        },
        other => {
            return Ok(format!(
                "I can't read a .{other} file as text. I can open it in its default app instead."
            ))
        }
    };

    let total = text.chars().count();
    let body: String = text.chars().take(cap).collect();
    let note = if total > cap {
        format!("\n\n[…truncated; {total} chars total…]")
    } else {
        String::new()
    };
    Ok(format!("{body}{note}"))
}

/// The shared document pipeline (Phase 2): decode base64 bytes, write them to a
/// temp file (preserving the extension so the right converter runs), extract
/// readable text capped at `cap` chars, and clean up. Reused by BOTH the chat
/// doc-upload affordance and email attachments, so every "read this document"
/// path — uploads, attachments, future connectors — behaves identically.
pub async fn extract_bytes_text(name: &str, base64: &str, cap: usize) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64.trim())
        .map_err(|e| format!("bad document data: {e}"))?;
    let safe: String = name
        .chars()
        .map(|c| if c == '/' || c == '\\' { '_' } else { c })
        .collect();
    let mut tmp = std::env::temp_dir();
    tmp.push(format!("brain-attach-{}-{}", std::process::id(), safe));
    std::fs::write(&tmp, &bytes).map_err(|e| format!("temp write failed: {e}"))?;
    let path = tmp.to_string_lossy().to_string();
    let res = extract_text(&path, cap).await;
    let _ = std::fs::remove_file(&tmp);
    res
}

/// Extract text from an uploaded attachment delivered as base64 bytes (chat
/// doc-upload affordance). Thin wrapper over the shared `extract_bytes_text`.
#[tauri::command]
pub async fn extract_doc_text(name: String, base64: String) -> Result<String, String> {
    extract_bytes_text(&name, &base64, 20000).await
}

/// Open a file or folder in its default application.
#[tauri::command]
pub async fn open_file(path: String) -> Result<String, String> {
    let path = expand_home(&path);
    if !Path::new(&path).exists() {
        return Err(format!("Path not found: {path}"));
    }
    run("/usr/bin/open", &[&path]).await?;
    Ok(format!("Opened {path}"))
}

/// Launch / activate a macOS application by name.
#[tauri::command]
pub async fn open_app(name: String) -> Result<String, String> {
    match run("/usr/bin/open", &["-a", &name]).await {
        Ok(_) => Ok(format!("Opened {name}.")),
        Err(_) => Err(format!(
            "Couldn't open \"{name}\" — it may not be installed. Try list_apps to see what's available."
        )),
    }
}

/// List installed applications (so the model knows what it can open/control).
#[tauri::command]
pub async fn list_apps() -> Result<String, String> {
    let mut names: Vec<String> = Vec::new();
    for dir in ["/Applications", "/System/Applications", "/System/Applications/Utilities"] {
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().to_string();
                if let Some(stripped) = n.strip_suffix(".app") {
                    names.push(stripped.to_string());
                }
            }
        }
    }
    names.sort();
    names.dedup();
    names.truncate(150);
    Ok(format!("Installed apps:\n{}", names.join(", ")))
}

/// Control a Mac app via AppleScript. macOS prompts the user to allow controlling
/// each new app the first time (Automation permission) — that prompt IS the access
/// request. Use for assistant actions (create a note, add a reminder, etc.).
#[tauri::command]
pub async fn run_applescript(script: String) -> Result<String, String> {
    if script.trim().is_empty() {
        return Err("Empty script".into());
    }
    let out = timeout(
        Duration::from_secs(40),
        Command::new("/usr/bin/osascript")
            .arg("-e")
            .arg(&script)
            .env("PATH", augmented_path())
            .output(),
    )
    .await
    .map_err(|_| "AppleScript timed out".to_string())?
    .map_err(|e| format!("osascript failed: {e}"))?;

    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if out.status.success() {
        return Ok(if stdout.is_empty() { "Done.".into() } else { stdout });
    }
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    let low = err.to_lowercase();
    if err.contains("-1743") || low.contains("not allowed") || low.contains("not authori") {
        Err(format!(
            "macOS hasn't granted control of that app yet. Approve the permission prompt when it \
             appears (or enable it under System Settings → Privacy & Security → Automation), then \
             ask me again. ({err})"
        ))
    } else {
        Err(format!("AppleScript error: {err}"))
    }
}

/// Run an osascript snippet, returning trimmed stdout. Maps macOS permission
/// denials (Automation/Accessibility) to a clear, actionable message.
async fn osa(script: &str) -> Result<String, String> {
    let out = timeout(
        Duration::from_secs(15),
        Command::new("/usr/bin/osascript")
            .arg("-e")
            .arg(script)
            .env("PATH", augmented_path())
            .output(),
    )
    .await
    .map_err(|_| "AppleScript timed out".to_string())?
    .map_err(|e| format!("osascript failed: {e}"))?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).trim().to_string());
    }
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    let low = err.to_lowercase();
    if err.contains("-1743") || low.contains("not allowed") || low.contains("not authori") {
        Err(format!(
            "macOS hasn't granted the needed permission yet (Automation/Accessibility). Approve \
             the prompt when it appears, or enable it under System Settings → Privacy & Security, \
             then ask again. ({err})"
        ))
    } else {
        Err(format!("AppleScript error: {err}"))
    }
}

/// Read the current system output volume (0–100), defaulting to 50 if unreadable.
async fn current_volume() -> i64 {
    osa("output volume of (get volume settings)")
        .await
        .ok()
        .and_then(|s| s.trim().parse::<i64>().ok())
        .unwrap_or(50)
}

/// Play/pause or skip on whichever supported media app is running.
async fn media_control(cmd: &str) -> Result<String, String> {
    let script = format!(
        "if application \"Spotify\" is running then\n\
            tell application \"Spotify\" to {cmd}\n\
            return \"Spotify\"\n\
         else if application \"Music\" is running then\n\
            tell application \"Music\" to {cmd}\n\
            return \"Music\"\n\
         else\n\
            return \"none\"\n\
         end if"
    );
    let who = osa(&script).await?;
    if who == "none" {
        Err("No supported media app is running (open Spotify or Music first).".into())
    } else {
        Ok(format!("{cmd} on {who}."))
    }
}

/// Curated, reliable macOS system controls — volume, mute, brightness, media
/// transport, display sleep, and lock. Each action is a known-good incantation,
/// which is far more reliable for a small local model than free-form AppleScript.
#[tauri::command]
pub async fn system_control(action: String, value: Option<i64>) -> Result<String, String> {
    match action.trim().to_lowercase().as_str() {
        "volume_get" => Ok(format!("System volume is at {}%.", current_volume().await)),
        "volume_set" => {
            let v = value.unwrap_or(50).clamp(0, 100);
            osa(&format!("set volume output volume {v}")).await?;
            Ok(format!("Set system volume to {v}%."))
        }
        "volume_up" => {
            let v = (current_volume().await + value.unwrap_or(10)).clamp(0, 100);
            osa(&format!("set volume output volume {v}")).await?;
            Ok(format!("Turned the volume up to {v}%."))
        }
        "volume_down" => {
            let v = (current_volume().await - value.unwrap_or(10)).clamp(0, 100);
            osa(&format!("set volume output volume {v}")).await?;
            Ok(format!("Turned the volume down to {v}%."))
        }
        "mute" => {
            osa("set volume with output muted").await?;
            Ok("Muted system audio.".into())
        }
        "unmute" => {
            osa("set volume without output muted").await?;
            Ok("Unmuted system audio.".into())
        }
        "brightness_up" => {
            osa("tell application \"System Events\" to key code 144").await?;
            Ok("Increased screen brightness.".into())
        }
        "brightness_down" => {
            osa("tell application \"System Events\" to key code 145").await?;
            Ok("Decreased screen brightness.".into())
        }
        "media_playpause" | "media_play" | "media_pause" => media_control("playpause").await,
        "media_next" => media_control("next track").await,
        "media_prev" | "media_previous" => media_control("previous track").await,
        "sleep_display" => {
            run("/usr/bin/pmset", &["displaysleepnow"]).await?;
            Ok("Put the display to sleep.".into())
        }
        "lock_screen" => {
            // With "require password after sleep" on (the default), sleeping the
            // display locks the Mac. Avoids needing Accessibility for a keystroke.
            run("/usr/bin/pmset", &["displaysleepnow"]).await?;
            Ok("Locking the screen (display put to sleep).".into())
        }
        other => Err(format!(
            "Unknown system action '{other}'. Supported: volume_get, volume_set, volume_up, \
             volume_down, mute, unmute, brightness_up, brightness_down, media_playpause, \
             media_next, media_prev, sleep_display, lock_screen."
        )),
    }
}

// ---------------------------------------------------------------------------
// iMessage  ->  send via AppleScript (Messages.app), read via the chat.db SQLite
// ---------------------------------------------------------------------------

/// Escape a string for safe interpolation INTO an AppleScript double-quoted
/// literal: backslash first (so we don't double-escape our own escapes), then
/// the quote.
fn as_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Send an iMessage (or SMS, if iMessage isn't available for the recipient) to a
/// phone number or Apple ID email via Messages.app. Sends on Andres' behalf, so
/// it is gated behind an explicit `confirm=true` the model only passes after he
/// approves, and every attempt is logged.
#[tauri::command]
pub async fn send_imessage(
    to: String,
    body: String,
    confirm: Option<bool>,
) -> Result<String, String> {
    let to = to.trim().to_string();
    let body = body.trim().to_string();
    if to.is_empty() || body.is_empty() {
        return Err("Both a recipient (`to`) and a message (`body`) are required.".into());
    }
    if !confirm.unwrap_or(false) {
        return Ok(format!(
            "CONFIRMATION REQUIRED before sending this iMessage:\n\n  To: {to}\n  Message: {body}\n\n\
             Show Andres exactly who it's going to and what it says, wait for his explicit 'yes', \
             then call send_imessage again with confirm=true. Do NOT set confirm=true on your own."
        ));
    }

    // Resolve an iMessage service explicitly and send to that buddy. The first
    // send to Messages triggers macOS's Automation permission prompt for the app.
    let script = format!(
        "tell application \"Messages\"\n\
            set targetService to 1st service whose service type = iMessage\n\
            set targetBuddy to buddy \"{to}\" of targetService\n\
            send \"{body}\" to targetBuddy\n\
         end tell",
        to = as_escape(&to),
        body = as_escape(&body),
    );

    let started = Instant::now();
    let res = osa(&script).await;
    let ms = started.elapsed().as_millis();
    match res {
        Ok(_) => {
            tool_log("send_imessage", "send", &to, "ok", ms, None);
            Ok(format!("iMessage sent to {to}."))
        }
        Err(e) => {
            tool_log("send_imessage", "send", &to, "error", ms, Some(&e));
            Err(e)
        }
    }
}

/// Read recent iMessage/SMS history from the local Messages database
/// (`~/Library/Messages/chat.db`). Optionally filter to one contact (phone or
/// email substring). Read-only. Requires Full Disk Access for Brain Avatar.
#[tauri::command]
pub async fn read_imessage(
    contact: Option<String>,
    limit: Option<u32>,
) -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let db = format!("{home}/Library/Messages/chat.db");
    if !Path::new(&db).exists() {
        return Err(format!("Messages database not found at {db}."));
    }
    let n = limit.unwrap_or(20).clamp(1, 50);

    // Apple stores `message.date` as nanoseconds since 2001-01-01; convert to a
    // local timestamp. On modern macOS `message.text` is usually NULL and the body
    // lives in `attributedBody` (a typedstream blob), so we also pull it as hex and
    // recover the text in Rust. Newlines in the text are flattened in SQL so one
    // message never spans multiple output rows (which would corrupt parsing).
    let where_clause = match contact.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        Some(c) => format!("WHERE handle.id LIKE '%{}%'", c.replace('\'', "''")),
        None => String::new(),
    };
    let query = format!(
        "SELECT datetime(message.date/1000000000 + 978307200, 'unixepoch', 'localtime') AS d, \
                COALESCE(handle.id, 'unknown') AS who, \
                message.is_from_me, \
                COALESCE(replace(replace(message.text, char(10), ' '), char(13), ' '), '') AS body, \
                COALESCE(hex(message.attributedBody), '') AS body2 \
         FROM message \
         LEFT JOIN handle ON message.handle_id = handle.ROWID \
         {where_clause} \
         ORDER BY message.date DESC LIMIT {n};"
    );

    let stdout = run_lenient(
        "/usr/bin/sqlite3",
        &["-separator", "\u{1f}", db.as_str(), query.as_str()],
    )
    .await;

    if stdout.trim().is_empty() {
        // Distinguish "no rows" from "couldn't open" by probing access once.
        let probe = run("/usr/bin/sqlite3", &[db.as_str(), "SELECT 1;"]).await;
        if let Err(e) = probe {
            let low = e.to_lowercase();
            if low.contains("authorization denied")
                || low.contains("unable to open")
                || low.contains("operation not permitted")
            {
                return Err(
                    "Couldn't read Messages — Brain Avatar needs Full Disk Access. Enable it under \
                     System Settings → Privacy & Security → Full Disk Access, then relaunch."
                        .into(),
                );
            }
            return Err(format!("Couldn't read Messages: {e}"));
        }
        return Ok(match &contact {
            Some(c) => format!("No messages found with \"{c}\"."),
            None => "No recent messages found.".into(),
        });
    }

    let mut out = String::from("Recent messages (newest first):\n\n");
    for line in stdout.lines().take(n as usize) {
        let cols: Vec<&str> = line.split('\u{1f}').collect();
        if cols.len() < 5 {
            continue;
        }
        let when = cols[0];
        let who = cols[1];
        let from_me = cols[2] == "1";
        // Prefer the plain `text` column; fall back to recovering it from the
        // attributedBody blob (the common case on modern macOS).
        let mut text = cols[3].trim().to_string();
        if text.is_empty() {
            if let Some(t) = decode_hex(cols[4]).as_deref().and_then(text_from_attributed_body) {
                text = t;
            }
        }
        let shown = if text.is_empty() {
            "(attachment or non-text message)".to_string()
        } else {
            text.replace('\n', " ")
        };
        let label = if from_me { "Andres".to_string() } else { who.to_string() };
        out.push_str(&format!("• [{when}] {label}: {shown}\n"));
    }
    Ok(out)
}

/// Decode an uppercase/lowercase hex string (as emitted by SQLite `hex()`) to
/// bytes. Returns None on any non-hex / odd-length input.
fn decode_hex(s: &str) -> Option<Vec<u8>> {
    let s = s.trim();
    if s.is_empty() || s.len() % 2 != 0 {
        return None;
    }
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(s.len() / 2);
    let mut i = 0;
    while i < b.len() {
        let hi = (b[i] as char).to_digit(16)?;
        let lo = (b[i + 1] as char).to_digit(16)?;
        out.push((hi * 16 + lo) as u8);
        i += 2;
    }
    Some(out)
}

/// Best-effort recovery of a message body from a Messages `attributedBody`
/// typedstream blob. The text is an NSString stored right after the `NSString`
/// marker: a few framing bytes, a `+` (0x2B), a length, then the UTF-8 bytes.
/// Every index is bounds-checked, so a malformed blob simply yields None rather
/// than panicking. Heuristic — not a full typedstream parser — but it recovers
/// the vast majority of real messages.
fn text_from_attributed_body(bytes: &[u8]) -> Option<String> {
    let marker = b"NSString";
    let pos = bytes.windows(marker.len()).position(|w| w == marker)?;
    let mut i = pos + marker.len();
    // Scan a short window forward to the 0x2B byte that precedes the length.
    let end_scan = (i + 12).min(bytes.len());
    while i < end_scan && bytes[i] != 0x2b {
        i += 1;
    }
    if i >= bytes.len() || bytes[i] != 0x2b {
        return None;
    }
    i += 1; // past the '+'
    if i >= bytes.len() {
        return None;
    }
    // Length is 1 byte (< 0x81) or 0x81 followed by a little-endian u16.
    let len = if bytes[i] < 0x81 {
        let l = bytes[i] as usize;
        i += 1;
        l
    } else if bytes[i] == 0x81 {
        if i + 2 >= bytes.len() {
            return None;
        }
        let l = u16::from_le_bytes([bytes[i + 1], bytes[i + 2]]) as usize;
        i += 3;
        l
    } else {
        return None;
    };
    let end = i.checked_add(len)?;
    if end > bytes.len() {
        return None;
    }
    let s = String::from_utf8_lossy(&bytes[i..end]).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

// ---------------------------------------------------------------------------
// browser_control  ->  drive the user's real Google Chrome via AppleScript
// ---------------------------------------------------------------------------

/// Run JavaScript in Chrome's active tab. Needs Chrome's one-time opt-in
/// (View → Developer → "Allow JavaScript from Apple Events"); we detect the
/// "turned off" error and tell the user how to enable it.
async fn chrome_js(js: &str) -> Result<String, String> {
    let script = format!(
        "tell application \"Google Chrome\" to execute active tab of front window javascript \"{}\"",
        as_escape(js)
    );
    match osa(&script).await {
        Ok(s) => Ok(s),
        Err(e) => {
            let low = e.to_lowercase();
            if low.contains("turned off") || low.contains("javascript") {
                Err("Chrome blocks JavaScript via AppleScript by default. Enable it once: \
                     Chrome menu bar → View → Developer → \"Allow JavaScript from Apple Events\", \
                     then try again."
                    .into())
            } else {
                Err(e)
            }
        }
    }
}

/// Curated Google Chrome controls — a small-model-friendly action set (like
/// system_control), so the model picks an action + simple params instead of
/// writing fragile AppleScript/JS. Read actions (current_url, list_tabs,
/// read_page) are safe; mutating ones (click_text, run_js) are confirm-gated by
/// the agent layer before they reach here.
#[tauri::command]
pub async fn browser_control(
    action: String,
    target: Option<String>,
    text: Option<String>,
) -> Result<String, String> {
    match action.trim().to_lowercase().as_str() {
        "open_url" => {
            let url = target
                .filter(|u| !u.trim().is_empty())
                .ok_or("open_url needs `target` (the URL to open)")?;
            let url = if url.starts_with("http://") || url.starts_with("https://") {
                url
            } else {
                format!("https://{url}")
            };
            let script = format!(
                "tell application \"Google Chrome\"\n\
                    activate\n\
                    if (count of windows) = 0 then\n\
                        make new window\n\
                        set URL of active tab of front window to \"{u}\"\n\
                    else\n\
                        tell front window to make new tab with properties {{URL:\"{u}\"}}\n\
                    end if\n\
                 end tell",
                u = as_escape(&url),
            );
            osa(&script).await.map(|_| format!("Opened {url} in Chrome."))
        }
        "current_url" | "active_tab" => {
            let script = "tell application \"Google Chrome\" to return (URL of active tab of \
                          front window) & \" ||| \" & (title of active tab of front window)";
            osa(script).await.map(|s| format!("Active tab: {s}"))
        }
        "list_tabs" => {
            let script = "tell application \"Google Chrome\"\n\
                            set out to \"\"\n\
                            repeat with t in (tabs of front window)\n\
                                set out to out & (title of t) & \" — \" & (URL of t) & linefeed\n\
                            end repeat\n\
                            return out\n\
                          end tell";
            osa(script).await.map(|s| {
                if s.trim().is_empty() {
                    "No open tabs.".into()
                } else {
                    format!("Open tabs in the front Chrome window:\n{s}")
                }
            })
        }
        "read_page" | "read_page_text" => {
            let js = "(function(){return document.body?document.body.innerText.slice(0,8000):'(no readable body)';})()";
            let body = chrome_js(js).await?;
            Ok(if body.trim().is_empty() {
                "(the page has no readable text)".into()
            } else {
                format!("Active tab text:\n\n{body}")
            })
        }
        "click_text" => {
            let t = target
                .filter(|s| !s.trim().is_empty())
                .ok_or("click_text needs `target` (the visible text of the link/button to click)")?;
            let lit = serde_json::to_string(&t).unwrap_or_else(|_| "\"\"".into());
            let js = format!(
                "(function(){{var t={lit}.toLowerCase();\
                  var els=[].slice.call(document.querySelectorAll('a,button,input[type=submit],input[type=button],[role=button]'));\
                  var el=els.filter(function(e){{return ((e.innerText||e.value||'')+'').toLowerCase().indexOf(t)>=0;}})[0];\
                  if(el){{el.click();return 'clicked: '+((el.innerText||el.value||el.tagName)+'').slice(0,80);}}\
                  return 'no clickable element matching: '+t;}})()"
            );
            chrome_js(&js).await
        }
        "run_js" => {
            let js = text
                .or(target)
                .filter(|s| !s.trim().is_empty())
                .ok_or("run_js needs `text` (the JavaScript to run in the page)")?;
            chrome_js(&js).await
        }
        other => Err(format!(
            "Unknown browser action '{other}'. Supported: open_url, current_url, list_tabs, \
             read_page, click_text, run_js."
        )),
    }
}
