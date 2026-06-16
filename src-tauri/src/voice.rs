use crate::config::{Settings, SettingsState};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::time::Duration;
use tauri::State;

/// Transcribe a recorded audio blob (base64) via Groq Whisper.
#[tauri::command]
pub async fn transcribe_audio(
    audio_base64: String,
    mime: Option<String>,
    state: State<'_, SettingsState>,
) -> Result<String, String> {
    let s = { state.0.lock().unwrap().clone() };
    transcribe_audio_core(&s, audio_base64, mime).await
}

pub async fn transcribe_audio_core(
    settings: &Settings,
    audio_base64: String,
    mime: Option<String>,
) -> Result<String, String> {
    let key = settings.groq_api_key.clone();
    let model = settings.groq_model.clone();
    if key.trim().is_empty() {
        return Err("Groq API key is not set — configure it in Settings to use voice.".into());
    }

    let bytes = STANDARD
        .decode(audio_base64.as_bytes())
        .map_err(|e| format!("bad audio payload: {e}"))?;

    let mime = mime.unwrap_or_else(|| "audio/webm".into());
    let filename = if mime.contains("wav") {
        "audio.wav"
    } else if mime.contains("mp4") || mime.contains("m4a") {
        "audio.mp4"
    } else if mime.contains("ogg") {
        "audio.ogg"
    } else {
        "audio.webm"
    };

    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(filename)
        .mime_str(&mime)
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", model)
        .text("response_format", "text");

    let client = reqwest::Client::new();
    let resp = client
        .post("https://api.groq.com/openai/v1/audio/transcriptions")
        .header("Authorization", format!("Bearer {key}"))
        .multipart(form)
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| format!("Groq request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Groq transcription HTTP {status}: {body}"));
    }
    Ok(resp.text().await.map_err(|e| e.to_string())?.trim().to_string())
}
