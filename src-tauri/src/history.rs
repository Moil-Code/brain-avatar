use crate::config::SettingsState;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::Duration;
use tauri::State;

#[derive(Serialize, Deserialize)]
pub struct StoredMessage {
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub created_at: Option<String>,
}

fn sync_config(state: &State<'_, SettingsState>) -> Option<(String, String)> {
    let s = state.0.lock().unwrap();
    let url = s.sync_api_url.trim_end_matches('/').to_string();
    if url.is_empty() {
        return None;
    }
    Some((url, s.sync_token.clone()))
}

/// Persist a single chat turn to the Vercel/Supabase history layer.
/// No-ops silently when sync isn't configured so the app stays fully local-capable.
#[tauri::command]
pub async fn save_message(
    conversation_id: String,
    role: String,
    content: String,
    state: State<'_, SettingsState>,
) -> Result<(), String> {
    let Some((url, token)) = sync_config(&state) else {
        return Ok(());
    };
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{url}/api/messages"))
        .header("Authorization", format!("Bearer {token}"))
        .json(&json!({
            "conversationId": conversation_id,
            "role": role,
            "content": content,
        }))
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("history save HTTP {}", resp.status()));
    }
    Ok(())
}

/// Load recent messages for a conversation from the history layer.
#[tauri::command]
pub async fn fetch_messages(
    conversation_id: String,
    limit: Option<u32>,
    state: State<'_, SettingsState>,
) -> Result<Vec<StoredMessage>, String> {
    let Some((url, token)) = sync_config(&state) else {
        return Ok(vec![]);
    };
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{url}/api/messages"))
        .query(&[
            ("conversationId", conversation_id.as_str()),
            ("limit", &limit.unwrap_or(100).to_string()),
        ])
        .header("Authorization", format!("Bearer {token}"))
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("history fetch HTTP {}", resp.status()));
    }
    resp.json::<Vec<StoredMessage>>().await.map_err(|e| e.to_string())
}
