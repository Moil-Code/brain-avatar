use crate::config::SettingsState;
use std::process::Stdio;
use std::sync::Mutex;
use tauri::State;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

/// Tracks the PID of the currently-speaking `say` process so we can interrupt it.
pub struct TtsState(pub Mutex<Option<u32>>);

fn kill_pid(pid: u32) {
    let _ = std::process::Command::new("/bin/kill")
        .arg(pid.to_string())
        .status();
}

/// Speak text using macOS `say`, which can use the high-quality Enhanced/Premium
/// voices (downloaded free in System Settings) that the webview cannot reach.
/// Interrupts any in-progress speech first. Resolves when speech finishes.
#[tauri::command]
pub async fn tts_speak(
    text: String,
    voice: Option<String>,
    tts: State<'_, TtsState>,
    settings: State<'_, SettingsState>,
) -> Result<(), String> {
    let voice = voice
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| settings.0.lock().unwrap().tts_voice.clone());

    // Interrupt anything currently speaking.
    if let Some(pid) = tts.0.lock().unwrap().take() {
        kill_pid(pid);
    }
    if text.trim().is_empty() {
        return Ok(());
    }

    let mut cmd = Command::new("/usr/bin/say");
    if !voice.trim().is_empty() {
        cmd.arg("-v").arg(&voice);
    }
    cmd.stdin(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("`say` failed to start: {e}"))?;
    let pid = child.id();
    *tts.0.lock().unwrap() = pid;

    // Feed text via stdin (avoids argv length limits for reading long files).
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(text.as_bytes()).await;
        // stdin dropped here -> EOF -> say begins speaking.
    }
    let _ = child.wait().await;

    // Clear our PID if it's still the one we set (not superseded/stopped).
    let mut guard = tts.0.lock().unwrap();
    if *guard == pid {
        *guard = None;
    }
    Ok(())
}

/// Stop any in-progress speech immediately.
#[tauri::command]
pub fn tts_stop(tts: State<'_, TtsState>) {
    if let Some(pid) = tts.0.lock().unwrap().take() {
        kill_pid(pid);
    }
}

/// Open macOS System Settings to the Spoken Content pane so the user can download a
/// natural Premium/Enhanced voice and set it as their System Voice. macOS does not
/// let apps download voices directly (gated behind Settings for consent + storage),
/// so this is the closest to "one click": it opens the right screen and macOS runs
/// its own download UI. Runs on whichever Mac the app is on (local, not proxied).
#[tauri::command]
pub fn open_voice_download() -> Result<(), String> {
    std::process::Command::new("/usr/bin/open")
        .arg("x-apple.systempreferences:com.apple.preference.universalaccess?SpokenContent")
        .status()
        .map_err(|e| format!("Couldn't open System Settings: {e}"))
        .and_then(|s| {
            if s.success() {
                Ok(())
            } else {
                Err("System Settings didn't open.".into())
            }
        })
}

/// List installed voices (includes Enhanced/Premium ones once downloaded) for the
/// Settings voice picker.
#[tauri::command]
pub async fn list_voices() -> Vec<String> {
    let out = Command::new("/usr/bin/say").arg("-v").arg("?").output().await;
    match out {
        Ok(o) => parse_voices(&String::from_utf8_lossy(&o.stdout)),
        Err(_) => vec![],
    }
}

fn parse_voices(s: &str) -> Vec<String> {
    s.lines()
        .filter_map(|line| {
            let toks: Vec<&str> = line.split_whitespace().collect();
            // The name is everything before the locale token (e.g. "en_US").
            let loc = toks.iter().position(|t| {
                t.len() == 5 && t.as_bytes().get(2) == Some(&b'_')
            })?;
            if loc == 0 {
                return None;
            }
            Some(toks[..loc].join(" "))
        })
        .collect()
}
