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

/// The bundled neural TTS sidecar (next to the app binary), if present. It uses
/// AVSpeechSynthesizer, which can speak Premium/Enhanced "Siri" voices that the
/// legacy `say` can't reach. Falls back to `say` when absent (e.g. swiftc-less build).
fn speak_helper() -> Option<std::path::PathBuf> {
    let p = std::env::current_exe().ok()?.with_file_name("speak-helper");
    p.exists().then_some(p)
}

/// The local Kokoro TTS wrapper (~/.kokoro-tts/kokoro-say), if installed. Kokoro is an
/// open-source neural voice that runs fully on-device — far more natural than `say`.
/// Reads text from stdin + takes the voice id as $1, exactly like the other backends.
fn kokoro_say() -> Option<std::path::PathBuf> {
    let p = std::path::Path::new(&std::env::var("HOME").ok()?).join(".kokoro-tts/kokoro-say");
    p.exists().then_some(p)
}

/// Kokoro voice ids look like `af_heart`, `am_michael`, `bf_emma` — two lowercase
/// letters, underscore, name. macOS voices ("Zoe (Premium)", "Samantha") never match,
/// so this cleanly selects the Kokoro backend without a separate engine setting.
fn is_kokoro_voice(v: &str) -> bool {
    let b = v.trim().as_bytes();
    b.len() >= 4 && b[2] == b'_' && b[0].is_ascii_lowercase() && b[1].is_ascii_lowercase()
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

    // Backend order: local Kokoro (open-source neural) when a Kokoro voice is selected
    // and installed → Premium-voice helper → legacy `say`. All three read text from
    // stdin and take the voice as an arg, so only the program differs.
    let mut cmd = if is_kokoro_voice(&voice) {
        match kokoro_say() {
            Some(k) => {
                let mut c = Command::new(k);
                c.arg(voice.trim());
                c
            }
            // Kokoro voice requested but wrapper missing — don't crash; use say default.
            None => Command::new("/usr/bin/say"),
        }
    } else {
        match speak_helper() {
            Some(h) => {
                let mut c = Command::new(h);
                c.arg(voice.trim()); // "" => helper uses the default voice
                c
            }
            None => {
                let mut c = Command::new("/usr/bin/say");
                if !voice.trim().is_empty() {
                    c.arg("-v").arg(&voice);
                }
                c
            }
        }
    };
    cmd.stdin(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("voice failed to start: {e}"))?;
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
    let mut voices: Vec<String> = Vec::new();
    // Local Kokoro (open-source neural) voices first when installed — the most natural,
    // and selecting one routes through the Kokoro backend (is_kokoro_voice).
    if kokoro_say().is_some() {
        voices.extend(
            ["af_heart", "af_bella", "am_michael", "am_fenrir", "bf_emma", "bm_george"]
                .iter()
                .map(|s| s.to_string()),
        );
    }
    // Then the neural helper's list (Premium/Enhanced macOS voices, quality-labelled,
    // best first). Fall back to `say -v ?` if the helper isn't bundled.
    if let Some(h) = speak_helper() {
        if let Ok(o) = Command::new(&h).arg("--list").output().await {
            let names: Vec<String> = String::from_utf8_lossy(&o.stdout)
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect();
            if !names.is_empty() {
                voices.extend(names);
                return voices;
            }
        }
    }
    if let Ok(o) = Command::new("/usr/bin/say").arg("-v").arg("?").output().await {
        voices.extend(parse_voices(&String::from_utf8_lossy(&o.stdout)));
    }
    voices
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

#[cfg(test)]
mod tts_tests {
    use super::is_kokoro_voice;
    #[test]
    fn detects_kokoro_ids_only() {
        for v in ["af_heart", "am_michael", "bf_emma", "bm_george"] {
            assert!(is_kokoro_voice(v), "{v} should be Kokoro");
        }
        for v in ["Zoe (Premium)", "Samantha", "Daniel", "", "Ava (Premium)"] {
            assert!(!is_kokoro_voice(v), "{v} should NOT be Kokoro");
        }
    }
}
