use serde::Serialize;
use std::time::Duration;

#[derive(Serialize)]
pub struct ProbeResult {
    pub ok: bool,
    pub models: Vec<String>,
    pub error: Option<String>,
}

/// Probe an LM Studio (OpenAI-compatible) endpoint: is it up, and what models
/// does it expose? Used by the frontend to pick a healthy endpoint + model and
/// by the Settings screen to populate the model dropdown.
#[tauri::command]
pub async fn llm_probe(base_url: String, token: Option<String>) -> ProbeResult {
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let mut req = client.get(&url).timeout(Duration::from_secs(6));
    if let Some(t) = token {
        if !t.trim().is_empty() {
            req = req.header("Authorization", format!("Bearer {t}"));
        }
    }
    match req.send().await {
        Ok(resp) if resp.status().is_success() => {
            let body: serde_json::Value = match resp.json().await {
                Ok(v) => v,
                Err(e) => {
                    return ProbeResult {
                        ok: false,
                        models: vec![],
                        error: Some(e.to_string()),
                    }
                }
            };
            let models = body
                .get("data")
                .and_then(|d| d.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|m| m.get("id").and_then(|v| v.as_str()).map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            ProbeResult {
                ok: true,
                models,
                error: None,
            }
        }
        Ok(resp) => ProbeResult {
            ok: false,
            models: vec![],
            error: Some(format!("HTTP {}", resp.status())),
        },
        Err(e) => ProbeResult {
            ok: false,
            models: vec![],
            error: Some(e.to_string()),
        },
    }
}
