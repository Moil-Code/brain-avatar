//! Automations store — the persistent list of scheduled tasks the avatar runs on
//! its own (e.g. "every Monday 9am email me Facebook metrics"). The SHAPE of each
//! automation is owned by the frontend (`src/lib/automations.ts`); Rust treats the
//! list as opaque JSON so the schema can evolve without touching Rust. Persisted as
//! `automations.json` next to `settings.json` in the app config dir.

use serde_json::Value;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

fn automations_path(app: &AppHandle) -> std::io::Result<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("automations.json"))
}

/// Return the saved automations as a JSON array (empty array if none/unreadable).
#[tauri::command]
pub fn get_automations(app: AppHandle) -> Value {
    match automations_path(&app).and_then(std::fs::read_to_string) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!([])),
        Err(_) => serde_json::json!([]),
    }
}

/// Persist the full automations array (the frontend always sends the whole list).
#[tauri::command]
pub fn set_automations(app: AppHandle, automations: Value) -> Result<(), String> {
    let path = automations_path(&app).map_err(|e| e.to_string())?;
    let raw = serde_json::to_string_pretty(&automations).map_err(|e| e.to_string())?;
    std::fs::write(path, raw).map_err(|e| e.to_string())
}
