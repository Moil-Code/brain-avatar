use crate::config::SettingsState;
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::ipc::Channel;
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

/// Stop all in-flight generations (called when the user presses Stop). Bumps the
/// local epoch (drops any direct LM Studio request) AND, in remote mode, POSTs to
/// the daemon's /llm/cancel — otherwise LM Studio *behind* the daemon keeps
/// generating after the MacBook hangs up (the daemon's blocking relay never noticed).
#[tauri::command]
pub fn cancel_generation(state: State<'_, CancelState>, settings: State<'_, SettingsState>) {
    let next = state.0.borrow().wrapping_add(1);
    let _ = state.0.send(next);

    let (url, token) = {
        let s = settings.0.lock().unwrap();
        (
            s.brain_daemon_url.trim().trim_end_matches('/').to_string(),
            s.brain_daemon_token.clone(),
        )
    };
    if !url.is_empty() {
        let endpoint = format!("{url}/llm/cancel");
        tokio::spawn(async move {
            let _ = reqwest::Client::new()
                .post(&endpoint)
                .header("Authorization", format!("Bearer {token}"))
                .timeout(Duration::from_secs(5))
                .send()
                .await;
        });
    }
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
    // Optional override for OpenAI `tool_choice` (default "auto"). The agent loop
    // sets this to "required" to force a tool call on round 0 of a multi-task
    // request (LM Studio rejects the named-function object form).
    tool_choice: Option<Value>,
    cancel: State<'_, CancelState>,
) -> Result<LlmResult, String> {
    llm_complete_core(
        base_url,
        token,
        model,
        messages,
        tools,
        max_tokens,
        tool_choice,
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
    tool_choice: Option<Value>,
    cancel: Option<tokio::sync::watch::Receiver<u64>>,
) -> Result<LlmResult, String> {
    // Tool-calling should be near-deterministic: at higher temperatures small models
    // (qwen3-8b) occasionally narrate an action ("I'll search…", "I found it") instead
    // of emitting the tool call, which then poisons the history and spirals. Use a low
    // temp when tools are offered; keep it warmer for plain prose answers.
    let has_tools = tools.as_ref().map(|t| !t.is_null()).unwrap_or(false);
    let mut body = json!({
        "model": model,
        "messages": messages,
        "temperature": if has_tools { 0.1 } else { 0.4 },
        "max_tokens": max_tokens.unwrap_or(4096),
        "stream": false,
    });
    if let Some(t) = tools {
        if !t.is_null() {
            body["tools"] = t;
            // Default to "auto"; the agent loop can force a specific tool (e.g.
            // manage_tasks) on round 0 of a multi-task request via tool_choice.
            body["tool_choice"] = match tool_choice {
                Some(tc) if !tc.is_null() => tc,
                _ => json!("auto"),
            };
        }
    }
    // Qwen3 and Gemma 4 are reasoning models with a <think> phase. Disable it for the
    // fast tiers (qwen3-8b tool tier, Gemma 4 E-series, dense 12B) so tool-calling /
    // quick answers stay fast and don't burn the token budget on reasoning. Keep it ON
    // only for the deep MoE (26B-A4B) — depth is the whole point of that tier. (Qwen3
    // honors this kwarg; Gemma 4 in LM Studio may need its reasoning parser configured
    // too — see docs/MODEL_PERFORMANCE_AUDIT.md.)
    let m = model.to_lowercase();
    let is_deep = m.contains("a4b") || m.contains("a3b") || m.contains("moe");
    if (m.contains("qwen") || m.contains("gemma")) && !is_deep {
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

/// Resolve when the cancel epoch changes from `start` — i.e. the user hit Stop.
/// Used to race a streaming read against cancellation without consuming the receiver.
async fn wait_cancel(rx: &mut tokio::sync::watch::Receiver<u64>, start: u64) {
    while rx.changed().await.is_ok() {
        if *rx.borrow() != start {
            return;
        }
    }
    std::future::pending::<()>().await;
}

/// Streaming sibling of `llm_complete`: identical request, but the answer's content
/// is pushed token-by-token over `on_delta` AS IT GENERATES — so the UI prints and
/// the voice speaks in step with the model instead of waiting for the whole answer.
/// Returns the same full `{content, tool_calls}` at the end, so the agent loop is
/// unchanged. The deep reasoning tier (26B-a4b/a3b/MoE — the only one that keeps
/// `<think>` on) is NOT streamed token-wise: its content is emitted once at the end
/// after reasoning markup is stripped, so the model's private reasoning is never
/// shown or spoken. On any failure the frontend falls back to `llm_complete`, so
/// this can only ever match or improve the existing behavior.
#[tauri::command]
pub async fn llm_stream(
    base_url: String,
    token: Option<String>,
    model: String,
    messages: Value,
    tools: Option<Value>,
    max_tokens: Option<u32>,
    tool_choice: Option<Value>,
    on_delta: Channel<String>,
    cancel: State<'_, CancelState>,
) -> Result<LlmResult, String> {
    let rx = cancel.0.subscribe();

    // Deep reasoning tier streams <think> tokens we must not show or speak. The
    // harmony "final channel" only resolves at the very end, so we can't strip it
    // incrementally — run it buffered (non-streaming) and emit the clean answer once.
    let m = model.to_lowercase();
    let is_deep = m.contains("a4b") || m.contains("a3b") || m.contains("moe");
    if is_deep {
        let res = llm_complete_core(
            base_url, token, model, messages, tools, max_tokens, tool_choice, Some(rx),
        )
        .await?;
        if !res.content.is_empty() {
            let _ = on_delta.send(res.content.clone());
        }
        return Ok(res);
    }

    llm_stream_core(
        base_url, token, model, messages, tools, max_tokens, tool_choice, on_delta, rx,
    )
    .await
}

/// Core streaming logic for the non-reasoning tiers. Parses the OpenAI SSE byte
/// stream, forwarding `delta.content` over the channel and accumulating any
/// `delta.tool_calls`, then returns the assembled `{content, tool_calls}`.
async fn llm_stream_core(
    base_url: String,
    token: Option<String>,
    model: String,
    messages: Value,
    tools: Option<Value>,
    max_tokens: Option<u32>,
    tool_choice: Option<Value>,
    on_delta: Channel<String>,
    mut rx: tokio::sync::watch::Receiver<u64>,
) -> Result<LlmResult, String> {
    let has_tools = tools.as_ref().map(|t| !t.is_null()).unwrap_or(false);
    let mut body = json!({
        "model": model,
        "messages": messages,
        "temperature": if has_tools { 0.1 } else { 0.4 },
        "max_tokens": max_tokens.unwrap_or(4096),
        "stream": true,
    });
    if let Some(t) = tools {
        if !t.is_null() {
            body["tools"] = t;
            body["tool_choice"] = match tool_choice {
                Some(tc) if !tc.is_null() => tc,
                _ => json!("auto"),
            };
        }
    }
    // These tiers don't reason; keep thinking off so nothing leaks into the stream.
    if m_is_thinkable(&model) {
        body["chat_template_kwargs"] = json!({ "enable_thinking": false });
    }

    let client = reqwest::Client::new();
    // A generous overall cap (a stream can outlive the 300s buffered cap); Stop and
    // a dropped connection are the real terminators.
    let mut req = client
        .post(format!("{}/chat/completions", base_url.trim_end_matches('/')))
        .json(&body)
        .timeout(Duration::from_secs(600));
    if let Some(t) = token {
        if !t.trim().is_empty() {
            req = req.header("Authorization", format!("Bearer {t}"));
        }
    }

    let start_epoch = *rx.borrow();
    let send_fut = req.send();
    tokio::pin!(send_fut);
    let resp = tokio::select! {
        r = &mut send_fut => r.map_err(decode_send_err)?,
        _ = wait_cancel(&mut rx, start_epoch) => return Err("cancelled".to_string()),
    };
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("LLM HTTP {status}: {}", text.chars().take(300).collect::<String>()));
    }

    let mut stream = resp.bytes_stream();
    let mut byte_buf: Vec<u8> = Vec::new();
    let mut content = String::new();
    let mut emitted = 0usize; // bytes of `content` already pushed over the channel
    // tool-call index -> (id, name, accumulated arguments-json)
    let mut tool_acc: std::collections::BTreeMap<u64, (String, String, String)> =
        std::collections::BTreeMap::new();

    loop {
        let chunk = tokio::select! {
            c = stream.next() => c,
            _ = wait_cancel(&mut rx, start_epoch) => return Err("cancelled".to_string()),
        };
        let bytes = match chunk {
            Some(Ok(b)) => b,
            Some(Err(e)) => return Err(decode_send_err(e)),
            None => break, // stream finished
        };
        byte_buf.extend_from_slice(&bytes);
        // An SSE event is one `data:` line ending in \n. Process only COMPLETE lines
        // (decoding at line boundaries keeps multi-byte chars from splitting mid-chunk).
        while let Some(pos) = byte_buf.iter().position(|&b| b == b'\n') {
            let raw: Vec<u8> = byte_buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&raw[..raw.len().saturating_sub(1)]);
            let payload = match line.trim().strip_prefix("data:") {
                Some(p) => p.trim().to_string(),
                None => continue,
            };
            if payload == "[DONE]" {
                continue;
            }
            let v: Value = match serde_json::from_str(&payload) {
                Ok(v) => v,
                Err(_) => continue, // partial/keepalive line
            };
            let choice = match v["choices"].get(0) {
                Some(c) => c,
                None => continue,
            };
            let delta = &choice["delta"];
            if let Some(c) = delta["content"].as_str() {
                if !c.is_empty() {
                    content.push_str(c);
                    // Thinking is off here, so content is clean prose — emit the new
                    // tail. If stray markup ever appears, stop streaming it; the
                    // cleaned full content is still returned for the UI to reconcile.
                    if !content.contains("<|")
                        && !content.contains("<think>")
                        && content.len() > emitted
                    {
                        let _ = on_delta.send(content[emitted..].to_string());
                        emitted = content.len();
                    }
                }
            }
            if let Some(tcs) = delta["tool_calls"].as_array() {
                for tc in tcs {
                    let idx = tc["index"].as_u64().unwrap_or(0);
                    let e = tool_acc
                        .entry(idx)
                        .or_insert_with(|| (String::new(), String::new(), String::new()));
                    if let Some(id) = tc["id"].as_str() {
                        if !id.is_empty() {
                            e.0 = id.to_string();
                        }
                    }
                    if let Some(n) = tc["function"]["name"].as_str() {
                        if !n.is_empty() {
                            e.1.push_str(n);
                        }
                    }
                    if let Some(a) = tc["function"]["arguments"].as_str() {
                        e.2.push_str(a);
                    }
                }
            }
        }
    }

    // Parity with the buffered path: strip any reasoning markup that slipped through.
    let final_content = if content.contains("<|") || content.contains("<think>") {
        strip_reasoning(&content)
    } else {
        content.clone()
    };
    let tool_calls = if tool_acc.is_empty() {
        Value::Null
    } else {
        Value::Array(
            tool_acc
                .into_iter()
                .map(|(idx, (id, name, args))| {
                    json!({
                        "id": if id.is_empty() { format!("call_{idx}") } else { id },
                        "type": "function",
                        "function": { "name": name, "arguments": args },
                    })
                })
                .collect(),
        )
    };
    Ok(LlmResult { content: final_content, tool_calls })
}

/// Whether the model honors `enable_thinking` (Qwen3 / Gemma 4 families).
fn m_is_thinkable(model: &str) -> bool {
    let m = model.to_lowercase();
    m.contains("qwen") || m.contains("gemma")
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
            // Show ONLY the currently-loaded models — the picker and router should
            // reflect what's actually resident on the 24GB box, not every model ever
            // downloaded (that's the "noise"). Fall back to the full list only on a
            // cold start (nothing loaded yet) so a JIT endpoint still offers choices
            // and the avatar is never stranded with an empty list.
            let models = if loaded.is_empty() { others } else { loaded };
            return ProbeResult { ok: true, models, error: None };
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
