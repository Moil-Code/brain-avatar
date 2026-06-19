//! watch_video — "watch a video for me and analyze it".
//!
//! Pipeline that reuses pieces we already have: yt-dlp downloads (URLs), ffmpeg
//! extracts a small 16 kHz mono audio track, Groq Whisper transcribes it, and the
//! transcript is handed back to the model to summarize/answer. Transcript-first by
//! design — it's model-agnostic and covers the vast majority of "analyze this
//! video" asks. (Visual frame analysis is a deliberate follow-up, gated on the
//! local vision model being confirmed.)

use crate::config::{augmented_path, SettingsState};
use crate::tools::tool_log;
use crate::voice::transcribe_audio_core;
use base64::{engine::general_purpose::STANDARD, Engine};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::State;
use tokio::process::Command;
use tokio::time::timeout;

const DL_TIMEOUT: Duration = Duration::from_secs(420); // downloads can be slow
const FF_TIMEOUT: Duration = Duration::from_secs(240);
/// Keep each transcription request under Groq's ~25 MB cap; split longer audio.
const STT_MAX_BYTES: u64 = 24 * 1024 * 1024;
const SEGMENT_SECONDS: u64 = 600; // 10-minute chunks when splitting
const MAX_TRANSCRIPT_CHARS: usize = 14000;

/// Run a CLI with augmented PATH + timeout; stdout on success, stderr on failure.
async fn run(program: &str, args: &[&str], to: Duration) -> Result<String, String> {
    let out = timeout(
        to,
        Command::new(program)
            .args(args)
            .env("PATH", augmented_path())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| format!("`{program}` timed out"))?
    .map_err(|e| format!("failed to run `{program}`: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(format!(
            "`{program}` failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

/// Is `program` runnable? (cheap presence check before the real work.)
async fn have(program: &str) -> bool {
    Command::new(program)
        .arg("--version")
        .env("PATH", augmented_path())
        .kill_on_drop(true)
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn expand_home(p: &str) -> String {
    if let Some(rest) = p.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return format!("{home}/{rest}");
        }
    }
    p.to_string()
}

/// Transcribe one audio file via Groq Whisper (read → base64 → STT core).
async fn transcribe_file(
    settings: &crate::config::Settings,
    path: &Path,
) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("couldn't read audio: {e}"))?;
    let b64 = STANDARD.encode(&bytes);
    transcribe_audio_core(settings, b64, Some("audio/mpeg".into())).await
}

/// Download or read the source and produce a single 16 kHz mono mp3 in `dir`.
/// Returns (audio_path, human_title).
async fn prepare_audio(dir: &Path, source: &str) -> Result<(PathBuf, String), String> {
    if source.starts_with("http://") || source.starts_with("https://") {
        if !have("yt-dlp").await {
            return Err("`yt-dlp` isn't installed — `brew install yt-dlp` to analyze online videos.".into());
        }
        // Title (best-effort; don't fail the whole job if metadata is unavailable).
        let title = run(
            "yt-dlp",
            &["--no-playlist", "--skip-download", "--print", "%(title)s", source],
            Duration::from_secs(60),
        )
        .await
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "the video".to_string());

        let out_tmpl = format!("{}/audio.%(ext)s", dir.display());
        run(
            "yt-dlp",
            &[
                "-x",
                "--audio-format",
                "mp3",
                "--no-playlist",
                "--postprocessor-args",
                "ffmpeg:-ar 16000 -ac 1 -b:a 64k",
                "-o",
                out_tmpl.as_str(),
                source,
            ],
            DL_TIMEOUT,
        )
        .await?;
        let audio = dir.join("audio.mp3");
        if !audio.exists() {
            return Err("Download finished but no audio file was produced.".into());
        }
        Ok((audio, title))
    } else {
        if !have("ffmpeg").await {
            return Err("`ffmpeg` isn't installed — `brew install ffmpeg` to analyze local videos.".into());
        }
        let input = expand_home(source);
        if !Path::new(&input).exists() {
            return Err(format!("File not found: {input}"));
        }
        let audio = dir.join("audio.mp3");
        let audio_s = audio.to_string_lossy().to_string();
        run(
            "ffmpeg",
            &[
                "-y", "-i", input.as_str(), "-vn", "-ar", "16000", "-ac", "1", "-b:a", "64k",
                audio_s.as_str(),
            ],
            FF_TIMEOUT,
        )
        .await?;
        let title = Path::new(&input)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "the video".to_string());
        Ok((audio, title))
    }
}

/// Transcribe `audio`, splitting into time segments first if it exceeds the STT
/// size cap (so long videos still work).
async fn transcribe_audio_path(
    settings: &crate::config::Settings,
    dir: &Path,
    audio: &Path,
) -> Result<String, String> {
    let size = std::fs::metadata(audio).map(|m| m.len()).unwrap_or(0);
    if size <= STT_MAX_BYTES {
        return transcribe_file(settings, audio).await;
    }
    // Split into chunkNNN.mp3 by time and transcribe each in order.
    if !have("ffmpeg").await {
        return Err("Audio is large and `ffmpeg` isn't available to split it for transcription.".into());
    }
    let pattern = format!("{}/chunk%03d.mp3", dir.display());
    let audio_s = audio.to_string_lossy().to_string();
    let seg = SEGMENT_SECONDS.to_string();
    run(
        "ffmpeg",
        &[
            "-y", "-i", audio_s.as_str(), "-f", "segment",
            "-segment_time", seg.as_str(), "-c", "copy", pattern.as_str(),
        ],
        FF_TIMEOUT,
    )
    .await?;
    let mut chunks: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("chunk") && n.ends_with(".mp3"))
                .unwrap_or(false)
        })
        .collect();
    chunks.sort();
    if chunks.is_empty() {
        return Err("Couldn't split the audio for transcription.".into());
    }
    let mut full = String::new();
    for c in &chunks {
        let part = transcribe_file(settings, c).await?;
        full.push_str(part.trim());
        full.push('\n');
    }
    Ok(full)
}

/// Watch a video (URL or local file): transcribe it and return the transcript +
/// metadata for the model to summarize or answer `question` about.
#[tauri::command]
pub async fn watch_video(
    source: String,
    question: Option<String>,
    state: State<'_, SettingsState>,
) -> Result<String, String> {
    let source = source.trim().to_string();
    if source.is_empty() {
        return Err("Provide a video URL or a local file path.".into());
    }
    let settings = { state.0.lock().unwrap().clone() };
    if settings.groq_api_key.trim().is_empty() {
        return Err("Transcription needs a Groq API key — set it in Settings → Voice.".into());
    }

    let started = Instant::now();
    let dir = std::env::temp_dir().join(format!("brain-video-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);

    let result = async {
        let (audio, title) = prepare_audio(&dir, &source).await?;
        let transcript = transcribe_audio_path(&settings, &dir, &audio).await?;
        let transcript = transcript.trim();
        if transcript.is_empty() {
            return Err("No speech was transcribed from this video.".to_string());
        }
        let total = transcript.chars().count();
        let body: String = transcript.chars().take(MAX_TRANSCRIPT_CHARS).collect();
        let note = if total > MAX_TRANSCRIPT_CHARS {
            format!("\n\n[…transcript truncated; {total} chars total…]")
        } else {
            String::new()
        };
        let task = match question.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
            Some(q) => format!("Using the transcript below, answer: {q}"),
            None => "Summarize what this video covers.".to_string(),
        };
        Ok(format!(
            "Transcript of \"{title}\" (auto-transcribed). {task}\n\n---\n{body}{note}"
        ))
    }
    .await;

    // Best-effort cleanup of the temp working dir.
    let _ = std::fs::remove_dir_all(&dir);

    let ms = started.elapsed().as_millis();
    match &result {
        Ok(_) => tool_log("watch_video", "analyze", &source, "ok", ms, None),
        Err(e) => tool_log("watch_video", "analyze", &source, "error", ms, Some(e)),
    }
    result
}
