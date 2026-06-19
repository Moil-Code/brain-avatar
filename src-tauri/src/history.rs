use crate::config::SettingsState;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

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
    // Stable per-message id (the UI message id) so the backend dedups retries.
    message_id: String,
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
            "messageId": message_id,
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

/// One conversation summary as returned by the Vercel `/api/conversations` view.
/// Field names match the backend columns; we remap into `ConvSummary` (below) so
/// the frontend can treat local + remote conversations uniformly.
#[derive(Deserialize)]
struct RemoteConvSummary {
    conversation_id: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    message_count: Option<usize>,
}

/// List conversations from the cloud history layer (those created on ANY device).
/// Returns the same shape as `list_conversations` so the UI can merge the two by id.
/// No-ops to an empty list when sync isn't configured or the call fails upstream.
#[tauri::command]
pub async fn fetch_conversations(
    limit: Option<u32>,
    state: State<'_, SettingsState>,
) -> Result<Vec<ConvSummary>, String> {
    let Some((url, token)) = sync_config(&state) else {
        return Ok(vec![]);
    };
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{url}/api/conversations"))
        .query(&[("limit", &limit.unwrap_or(200).to_string())])
        .header("Authorization", format!("Bearer {token}"))
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("conversations fetch HTTP {}", resp.status()));
    }
    let rows = resp
        .json::<Vec<RemoteConvSummary>>()
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|r| ConvSummary {
            title: match r.title {
                Some(t) if !t.trim().is_empty() => t,
                _ => "New chat".to_string(),
            },
            id: r.conversation_id,
            updated_at: r.updated_at.unwrap_or_default(),
            message_count: r.message_count.unwrap_or(0),
        })
        .collect())
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

/// Fetch all conversations for a given date from the local store, grouped with their
/// messages. Filters by the `ts` timestamp prefix on each message so only messages
/// from that calendar day are included. Works fully offline — no Supabase required.
#[tauri::command]
pub fn fetch_daily_digest(date: String, app: AppHandle) -> Result<String, String> {
    let d = if date.trim().is_empty() {
        chrono::Utc::now().format("%Y-%m-%d").to_string()
    } else {
        date
    };
    let store = load_store(&app);
    let convs: Vec<serde_json::Value> = store
        .conversations
        .iter()
        .filter_map(|c| {
            let msgs: Vec<serde_json::Value> = c
                .messages
                .iter()
                .filter(|m| m.ts.starts_with(&d))
                .map(|m| {
                    json!({ "role": m.role, "content": m.content, "created_at": m.ts })
                })
                .collect();
            if msgs.is_empty() {
                return None;
            }
            Some(json!({
                "conversation_id": c.id,
                "title": c.title,
                "messages": msgs,
            }))
        })
        .collect();
    serde_json::to_string(&json!({ "date": d, "conversations": convs }))
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Local conversation store — durable, offline, survives app updates. Lives in
// the app config dir as conversations.json. This is what powers "recent chats"
// (the Supabase layer above stays as an optional sync mirror).
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone)]
pub struct ConvMessage {
    pub role: String,
    pub content: String,
    pub ts: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub messages: Vec<ConvMessage>,
}

#[derive(Serialize, Deserialize, Default)]
pub struct ConvStore {
    pub conversations: Vec<Conversation>,
}

#[derive(Serialize)]
pub struct ConvSummary {
    pub id: String,
    pub title: String,
    pub updated_at: String,
    pub message_count: usize,
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("conversations.json"))
}

fn load_store(app: &AppHandle) -> ConvStore {
    match store_path(app).and_then(|p| std::fs::read_to_string(p).map_err(|e| e.to_string())) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => ConvStore::default(),
    }
}

fn save_store(app: &AppHandle, store: &ConvStore) -> Result<(), String> {
    let p = store_path(app)?;
    let raw = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    std::fs::write(p, raw).map_err(|e| e.to_string())
}

/// List saved conversations, newest first (no message bodies — lightweight).
#[tauri::command]
pub fn list_conversations(app: AppHandle) -> Vec<ConvSummary> {
    let mut store = load_store(&app);
    store.conversations.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    store
        .conversations
        .into_iter()
        .map(|c| ConvSummary {
            title: if c.title.trim().is_empty() {
                "New chat".to_string()
            } else {
                c.title
            },
            id: c.id,
            updated_at: c.updated_at,
            message_count: c.messages.len(),
        })
        .collect()
}

/// Full message history for one conversation.
#[tauri::command]
pub fn get_conversation(app: AppHandle, conversation_id: String) -> Vec<ConvMessage> {
    load_store(&app)
        .conversations
        .into_iter()
        .find(|c| c.id == conversation_id)
        .map(|c| c.messages)
        .unwrap_or_default()
}

/// Append one turn to a conversation (creating it if new). Titles auto-fill from
/// the first user message. Returns nothing; failures are non-fatal to the chat.
#[tauri::command]
pub fn append_turn(
    app: AppHandle,
    conversation_id: String,
    role: String,
    content: String,
) -> Result<(), String> {
    let mut store = load_store(&app);
    let now = chrono::Utc::now().to_rfc3339();
    let idx = store
        .conversations
        .iter()
        .position(|c| c.id == conversation_id);
    let i = match idx {
        Some(i) => i,
        None => {
            store.conversations.push(Conversation {
                id: conversation_id.clone(),
                title: String::new(),
                created_at: now.clone(),
                updated_at: now.clone(),
                messages: vec![],
            });
            store.conversations.len() - 1
        }
    };
    let conv = &mut store.conversations[i];
    if conv.title.trim().is_empty() && role == "user" {
        conv.title = content.chars().take(60).collect::<String>().replace('\n', " ");
    }
    conv.messages.push(ConvMessage {
        role,
        content,
        ts: now.clone(),
    });
    conv.updated_at = now;
    save_store(&app, &store)
}

/// Replace a conversation's messages in the local store with a caller-supplied set
/// (used to cache the cloud+local merge after opening a conversation, so it survives
/// offline and shows up in "recent chats"). Creates the conversation if it's new;
/// keeps an existing non-empty title. `updated_at` tracks the last message's ts.
#[tauri::command]
pub fn replace_conversation(
    app: AppHandle,
    conversation_id: String,
    title: String,
    messages: Vec<ConvMessage>,
) -> Result<(), String> {
    let mut store = load_store(&app);
    let now = chrono::Utc::now().to_rfc3339();
    let ts_or = |s: Option<&String>| -> String {
        s.filter(|t| !t.trim().is_empty()).cloned().unwrap_or_else(|| now.clone())
    };
    let created_at = ts_or(messages.first().map(|m| &m.ts));
    let updated_at = ts_or(messages.last().map(|m| &m.ts));
    match store.conversations.iter_mut().find(|c| c.id == conversation_id) {
        Some(c) => {
            if c.title.trim().is_empty() {
                c.title = title;
            }
            c.messages = messages;
            c.updated_at = updated_at;
        }
        None => store.conversations.push(Conversation {
            id: conversation_id,
            title,
            created_at,
            updated_at,
            messages,
        }),
    }
    save_store(&app, &store)
}

/// Delete a conversation from the local store AND the cloud history layer, so a
/// user-initiated delete is cross-device (otherwise the cloud copy would reappear in
/// the merged recent-chats list on the next open). The remote delete is best-effort:
/// the local delete is what the UI reflects, so a sync hiccup never blocks it.
#[tauri::command]
pub async fn delete_conversation(
    app: AppHandle,
    conversation_id: String,
    state: State<'_, SettingsState>,
) -> Result<(), String> {
    if let Some((url, token)) = sync_config(&state) {
        let id = conversation_id.clone();
        tokio::spawn(async move {
            let _ = reqwest::Client::new()
                .delete(format!("{url}/api/messages"))
                .query(&[("conversationId", id.as_str())])
                .header("Authorization", format!("Bearer {token}"))
                .timeout(Duration::from_secs(15))
                .send()
                .await;
        });
    }
    let mut store = load_store(&app);
    store.conversations.retain(|c| c.id != conversation_id);
    save_store(&app, &store)
}
