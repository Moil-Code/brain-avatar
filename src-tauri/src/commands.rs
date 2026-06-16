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

/// Whether the optional integrations are configured (drives UI affordances).
#[tauri::command]
pub fn feature_flags(state: State<'_, SettingsState>) -> serde_json::Value {
    let s = state.0.lock().unwrap();
    serde_json::json!({
        "voice": !s.groq_api_key.trim().is_empty(),
        "web": !s.brave_api_key.trim().is_empty(),
        "sync": !s.sync_api_url.trim().is_empty(),
        "remoteLlm": !s.lm_studio_remote_token.trim().is_empty(),
    })
}
