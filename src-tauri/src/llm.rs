use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Serialize)]
pub struct LlmResult {
    pub content: String,
    /// Raw OpenAI tool_calls array (or null) for the frontend agent loop.
    pub tool_calls: Value,
}

/// Run one chat completion against an OpenAI-compatible endpoint (LM Studio),
/// natively in Rust. Native HTTP avoids WKWebView's App Transport Security
/// blocking plain-HTTP local endpoints, and keeps the API token out of the webview.
#[tauri::command]
pub async fn llm_complete(
    base_url: String,
    token: Option<String>,
    model: String,
    messages: Value,
    tools: Option<Value>,
    max_tokens: Option<u32>,
) -> Result<LlmResult, String> {
    let mut body = json!({
        "model": model,
        "messages": messages,
        "temperature": 0.4,
        "max_tokens": max_tokens.unwrap_or(4096),
        "stream": false,
    });
    if let Some(t) = tools {
        if !t.is_null() {
            body["tools"] = t;
            body["tool_choice"] = json!("auto");
        }
    }

    let client = reqwest::Client::new();
    let mut req = client
        .post(format!("{}/chat/completions", base_url.trim_end_matches('/')))
        .json(&body)
        .timeout(Duration::from_secs(180));
    if let Some(t) = token {
        if !t.trim().is_empty() {
            req = req.header("Authorization", format!("Bearer {t}"));
        }
    }

    let resp = req.send().await.map_err(|e| format!("LLM request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("LLM HTTP {status}: {}", text.chars().take(300).collect::<String>()));
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    let msg = &v["choices"][0]["message"];
    let content = msg["content"].as_str().unwrap_or("").to_string();
    let tool_calls = msg.get("tool_calls").cloned().unwrap_or(Value::Null);
    Ok(LlmResult { content, tool_calls })
}

#[derive(Serialize)]
pub struct ProbeResult {
    pub ok: bool,
    pub models: Vec<String>,
    pub error: Option<String>,
}

async fn authed_get(url: &str, token: &Option<String>) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let mut req = client.get(url).timeout(Duration::from_secs(3));
    if let Some(t) = token {
        if !t.trim().is_empty() {
            req = req.header("Authorization", format!("Bearer {t}"));
        }
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    resp.json().await.map_err(|e| e.to_string())
}

/// Probe an LM Studio endpoint. Prefers LM Studio's native `/api/v0/models`
/// (which reports load state) so the model currently LOADED is listed first —
/// important because the 24GB Mac runs one model at a time and won't JIT-load
/// another. Falls back to the OpenAI `/v1/models` list.
#[tauri::command]
pub async fn llm_probe(base_url: String, token: Option<String>) -> ProbeResult {
    let trimmed = base_url.trim_end_matches('/');
    let native_base = trimmed.strip_suffix("/v1").unwrap_or(trimmed);

    // 1) Native endpoint with load states.
    if let Ok(body) = authed_get(&format!("{native_base}/api/v0/models"), &token).await {
        if let Some(arr) = body.get("data").and_then(|d| d.as_array()) {
            let mut loaded = vec![];
            let mut others = vec![];
            for m in arr {
                let id = match m.get("id").and_then(|v| v.as_str()) {
                    Some(s) => s.to_string(),
                    None => continue,
                };
                // Skip embedding models for chat selection.
                if m.get("type").and_then(|v| v.as_str()) == Some("embeddings") {
                    continue;
                }
                if m.get("state").and_then(|v| v.as_str()) == Some("loaded") {
                    loaded.push(id);
                } else {
                    others.push(id);
                }
            }
            loaded.extend(others);
            return ProbeResult { ok: true, models: loaded, error: None };
        }
    }

    // 2) OpenAI-compatible fallback.
    match authed_get(&format!("{trimmed}/models"), &token).await {
        Ok(body) => {
            let models = body
                .get("data")
                .and_then(|d| d.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|m| m.get("id").and_then(|v| v.as_str()).map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            ProbeResult { ok: true, models, error: None }
        }
        Err(e) => ProbeResult { ok: false, models: vec![], error: Some(e) },
    }
}
