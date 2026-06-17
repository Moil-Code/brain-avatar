use crate::config::{self, Settings, SettingsState};
use tauri::{AppHandle, State};

/// Return the full settings object (the Settings screen reads & edits this).
#[tauri::command]
pub fn get_settings(state: State<'_, SettingsState>) -> Settings {
    state.0.lock().unwrap().clone()
}

/// Persist new settings to disk and update the in-memory state.
#[tauri::command]
pub fn set_settings(
    app: AppHandle,
    new_settings: Settings,
    state: State<'_, SettingsState>,
) -> Result<(), String> {
    config::save(&app, &new_settings)?;
    *state.0.lock().unwrap() = new_settings;
    Ok(())
}

/// Post a native macOS Notification Center banner. Used by automations to surface
/// their results proactively (e.g. the morning briefing) without the model having a
/// tool for it. Fire-and-forget via osascript so no extra crates are pulled in.
#[tauri::command]
pub fn notify(title: String, body: String) -> Result<(), String> {
    // AppleScript string literals: escape backslashes first, then double quotes.
    let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    // Notification Center truncates long bodies anyway; keep it to one glanceable line.
    let body: String = body.chars().take(220).collect();
    let script = format!(
        "display notification \"{}\" with title \"{}\"",
        esc(&body),
        esc(&title)
    );
    std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .spawn()
        .map_err(|e| format!("notification failed: {e}"))?;
    Ok(())
}

/// Whether the optional integrations are configured (drives UI affordances).
#[tauri::command]
pub fn feature_flags(state: State<'_, SettingsState>) -> serde_json::Value {
    let s = state.0.lock().unwrap();
    // In remote mode (MacBook client) the daemon provides voice (Groq) and web
    // (Brave), so those capabilities are available even when the LOCAL keys are
    // empty — otherwise the mic button hides on the MacBook though voice works.
    let remote = !s.brain_daemon_url.trim().is_empty();
    serde_json::json!({
        "voice": remote || !s.groq_api_key.trim().is_empty(),
        "web": remote || !s.brave_api_key.trim().is_empty(),
        "sync": !s.sync_api_url.trim().is_empty(),
        "remoteLlm": !s.lm_studio_remote_token.trim().is_empty(),
    })
}
