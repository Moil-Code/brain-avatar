use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::State;

#[derive(Serialize)]
pub struct LlmResult {
    pub content: String,
    /// Raw OpenAI tool_calls array (or null) for the frontend agent loop.
    pub tool_calls: Value,
}

/// A monotonically-increasing "cancel epoch". When the user hits Stop, the epoch
/// is bumped; every in-flight llm_complete races its request against this and aborts
/// the moment it changes — which drops the HTTP connection so LM Studio (llama.cpp)
/// stops generating server-side instead of running to completion.
pub struct CancelState(pub tokio::sync::watch::Sender<u64>);

impl Default for CancelState {
    fn default() -> Self {
        CancelState(tokio::sync::watch::channel(0u64).0)
    }
}

/// Stop all in-flight generations (called when the user presses Stop).
#[tauri::command]
pub fn cancel_generation(state: State<'_, CancelState>) {
    let next = state.0.borrow().wrapping_add(1);
    let _ = state.0.send(next);
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
    cancel: State<'_, CancelState>,
) -> Result<LlmResult, String> {
    llm_complete_core(
        base_url,
        token,
        model,
        messages,
        tools,
        max_tokens,
        Some(cancel.0.subscribe()),
    )
    .await
}

fn decode_send_err(e: reqwest::Error) -> String {
    use std::error::Error as _;
    let mut msg = if e.is_timeout() {
        "the model took too long (timed out)".to_string()
    } else if e.is_connect() {
        "couldn't connect to the model server".to_string()
    } else {
        format!("{e}")
    };
    let mut src = e.source();
    while let Some(s) = src {
        msg.push_str(&format!(" — {s}"));
        src = s.source();
    }
    format!("LLM request failed: {msg}")
}

/// Core completion logic. `cancel` = an optional epoch receiver; when its value
/// changes, the in-flight request is dropped (Stop). The daemon passes None.
pub async fn llm_complete_core(
    base_url: String,
    token: Option<String>,
    model: String,
    messages: Value,
    tools: Option<Value>,
    max_tokens: Option<u32>,
    cancel: Option<tokio::sync::watch::Receiver<u64>>,
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
    // Qwen3 is a reasoning model; disable its <think> phase so tool-calling /
    // quick answers are fast and don't burn the token budget on reasoning.
    if model.to_lowercase().contains("qwen") {
        body["chat_template_kwargs"] = json!({ "enable_thinking": false });
    }

    let client = reqwest::Client::new();
    let mut req = client
        .post(format!("{}/chat/completions", base_url.trim_end_matches('/')))
        .json(&body)
        .timeout(Duration::from_secs(300));
    if let Some(t) = token {
        if !t.trim().is_empty() {
            req = req.header("Authorization", format!("Bearer {t}"));
        }
    }

    // Race the request against the cancel signal (if any). On Stop, drop the
    // request future → reqwest closes the connection → LM Studio stops generating.
    let send_fut = req.send();
    let resp = match cancel {
        Some(mut rx) => {
            let start_epoch = *rx.borrow();
            tokio::pin!(send_fut);
            tokio::select! {
                r = &mut send_fut => r.map_err(decode_send_err)?,
                _ = async {
                    while rx.changed().await.is_ok() {
                        if *rx.borrow() != start_epoch { return; }
                    }
                    std::future::pending::<()>().await;
                } => {
                    return Err("cancelled".to_string());
                }
            }
        }
        None => send_fut.await.map_err(decode_send_err)?,
    };
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("LLM HTTP {status}: {}", text.chars().take(300).collect::<String>()));
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    let msg = &v["choices"][0]["message"];
    let raw = msg["content"].as_str().unwrap_or("");
    // Reasoning models (gemma-4-26b-a4b, etc.) can leak harmony/think markup into
    // `content`. Strip it so the answer shown/spoken — and any JSON the router
    // parses — is clean. Only touch content that actually carries markup.
    let content = if raw.contains("<|") || raw.contains("<think>") {
        strip_reasoning(raw)
    } else {
        raw.to_string()
    };
    let tool_calls = msg.get("tool_calls").cloned().unwrap_or(Value::Null);
    Ok(LlmResult { content, tool_calls })
}

/// Remove reasoning-model markup: harmony channels (`<|channel|>…<|message|>`),
/// `<think>…</think>` blocks, and stray control tokens — keeping the final answer.
fn strip_reasoning(s: &str) -> String {
    let mut out = s.to_string();

    // Harmony: if there's a final channel, keep only its message text.
    if let Some(fi) = out.rfind("<|channel|>final") {
        let tail = out[fi..].to_string();
        if let Some(mi) = tail.find("<|message|>") {
            out = tail[mi + "<|message|>".len()..].to_string();
        } else if let Some(gi) = tail.find("|>") {
            out = tail[gi + 2..].to_string();
        }
    }

    // Drop <think>…</think> blocks.
    while let (Some(a), Some(b)) = (out.find("<think>"), out.find("</think>")) {
        if b > a {
            out.replace_range(a..b + "</think>".len(), "");
        } else {
            break;
        }
    }

    // Strip residual <|…|> control-token spans.
    let mut cleaned = String::with_capacity(out.len());
    let mut rest = out.as_str();
    while let Some(open) = rest.find("<|") {
        cleaned.push_str(&rest[..open]);
        match rest[open..].find("|>") {
            Some(close) => rest = &rest[open + close + 2..],
            None => {
                rest = &rest[open..];
                break;
            }
        }
    }
    cleaned.push_str(rest);

    // Leftover bare channel-name markers (e.g. "thought|>") if "<|" was absent.
    for tok in ["thought|>", "analysis|>", "final|>", "commentary|>"] {
        cleaned = cleaned.replace(tok, "");
    }
    cleaned.trim().to_string()
}

#[derive(Serialize)]
pub struct ProbeResult {
    pub ok: bool,
    pub models: Vec<String>,
    pub error: Option<String>,
}

async fn authed_get(url: &str, token: &Option<String>) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    // 6s, not 3s: a cold mDNS resolve of Mac-mini.local on the very first probe
    // after launch can take a few seconds, which is what made the first request fail.
    let mut req = client.get(url).timeout(Duration::from_secs(6));
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
