use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

/// Persistent application settings. Secrets and endpoints live here (in Rust),
/// not in the frontend. Stored as JSON in the app config directory.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    // --- LM Studio (remote 24GB Mac is primary, local host is fallback) ---
    pub lm_studio_local_url: String,
    pub lm_studio_remote_url: String,
    pub lm_studio_remote_token: String,
    /// Empty string => auto-select the model currently loaded on the endpoint.
    pub model: String,
    /// Generous by default: reasoning models (Gemma) fill reasoning_content first,
    /// so a low cap leaves `content` empty.
    pub max_tokens: u32,

    // --- Voice (Groq Whisper STT) ---
    pub groq_api_key: String,
    pub groq_model: String,

    // --- Web search (Brave) ---
    pub brave_api_key: String,

    // --- Local tool CLIs (absolute paths so the bundled .app can find them) ---
    pub gbrain_path: String,
    pub m365_path: String,
    /// Optional custom Entra app id for m365 (needed for Calendars.ReadWrite, etc.).
    pub m365_app_id: String,

    // --- History / sync (Vercel API -> Supabase) ---
    pub sync_api_url: String,
    pub sync_token: String,

    // --- Remote brain (MacBook client -> Mac Mini brain-daemon) ---
    /// When set, the brain-owner tools (brain/calendar/mail/web/stt) are proxied
    /// to this daemon over Tailscale instead of running locally. Empty = run
    /// locally (the Mac Mini's own behavior). e.g. "http://100.x.y.z:8787".
    pub brain_daemon_url: String,
    /// Bearer token the daemon requires (must match its BRAIN_DAEMON_TOKEN).
    pub brain_daemon_token: String,

    // --- Voice output (macOS `say`; empty = system default voice) ---
    pub tts_voice: String,

    // --- Behaviour ---
    pub system_prompt: String,
}

impl Default for Settings {
    fn default() -> Self {
        let home = dirs_home();
        Settings {
            lm_studio_local_url: "http://localhost:1234/v1".into(),
            lm_studio_remote_url: "http://Mac-mini.local:1234/v1".into(),
            lm_studio_remote_token: String::new(),
            // Blank => auto-select the model currently LOADED on the endpoint. The
            // 24GB Mac runs one model at a time and won't JIT-load another, so we
            // use whatever is loaded rather than requesting a fixed id. Set a
            // specific id in Settings to override.
            model: String::new(),
            max_tokens: 4096,
            groq_api_key: String::new(),
            groq_model: "whisper-large-v3-turbo".into(),
            brave_api_key: String::new(),
            gbrain_path: format!("{home}/.bun/bin/gbrain"),
            m365_path: "/opt/homebrew/bin/m365".into(),
            m365_app_id: String::new(),
            sync_api_url: String::new(),
            sync_token: String::new(),
            brain_daemon_url: String::new(),
            brain_daemon_token: String::new(),
            tts_voice: String::new(),
            system_prompt: default_system_prompt(),
        }
    }
}

fn dirs_home() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/Users/jarvisurrego".into())
}

pub fn default_system_prompt() -> String {
    "You are Brain, Andres Urrego's personal AI assistant for Moil. \
You are concise, direct, and warm. You have tools to search Andres' \
\"brain\" (a personal knowledge base of meetings, people, deals, concepts, and projects), \
to read his Microsoft 365 calendar, and to search the web. \
For a question about a specific named person, company, project, or concept (\"who is X\", \
\"what is X\", X's role/latest), ALWAYS call brain_page with the entity's name first — it \
returns the current canonical page, not stale transcripts. Use brain_search for broader or \
contextual questions about Moil, deals, or history. Use calendar_events to check the schedule \
and get event ids; calendar_create to schedule (set is_teams for a Teams meeting, list \
attendee emails to invite them), calendar_update to edit (e.g. make an event a Teams meeting), \
and calendar_delete to remove one. ALWAYS confirm the title, time, attendees, and Teams yes/no \
with Andres before creating, changing, or deleting an event. For looking things up on the web — \
general or current public information not in the brain — use web_search (Brave) FIRST: it is fast and \
reliable. Then use fetch_url to open and read any specific result or KNOWN page you want the details of. \
Use web_task — a REAL logged-in browser agent — only when a task needs a real browser SESSION (logging \
into a site, navigating moilapp.com, reading an authenticated dashboard, filling a form) OR as a FALLBACK \
when web_search is unavailable or didn't find it. Sites Andres logged into once stay logged in; if \
web_task hits a login wall, tell him to run the one-time login. Confirm before any web_task that posts \
or submits. When Andres asks you to look something up, web-search, or say what a site or URL is about, \
you MUST go to the LIVE web (web_search then fetch_url, or web_task for a logged-in site) and answer from \
the live page — do NOT answer from the brain, which may be outdated. \
You can read his inbox (read_emails for a list/preview; email_details to open ONE email and read \
its full body and the links inside it — use email_details, then fetch_url, when asked about an \
email's contents or to find/open a link in an email), send email (send_email), add reminders \
(create_reminder), and send Teams messages (send_teams_message); confirm recipients and \
content with Andres before sending anything. \
You can read his recent X (Twitter) bookmarks (x_bookmarks) — to summarize a bookmark, fetch_url \
its link first to actually read it; if x_bookmarks reports it isn't activated, relay the setup steps. \
You can generate images locally with generate_image (Bonsai) when he asks to create/draw/make a \
picture, logo, or illustration — write a vivid prompt; the image is shown to him automatically, so \
just confirm briefly afterward and don't try to describe the pixels. \
You can publish an image to Andres' Facebook Pages with post_to_facebook ('moil' = Moil by Jarvis, \
'jarvis_tx' = Jarvis AI TX) — typically right after generate_image. This POSTS PUBLICLY, so ALWAYS \
show Andres the image, caption, and page and get an explicit yes BEFORE calling it. \
You can read Facebook Page METRICS (read-only) with facebook_insights — follower count, 28-day \
reach, impressions, post engagement, and recent post performance — for 'how's the page doing' or \
'check my FB metrics'; summarize the numbers conversationally. \
You can set up RECURRING automations Brain runs on its own with create_automation — use it whenever \
Andres asks for something on a cadence ('every Monday', 'each morning', 'weekly', 'automatically \
check X and tell me'). The prompt you store is the instruction Brain runs each time. Confirm the \
schedule and what it will do, then create it. Use list_automations to tell him what's already running. \
You can also access Andres' Mac: find_files (Spotlight search), read_file (read a file's \
text — when asked to read a file aloud, read it and reply with its content so it is spoken), \
open_file (open something in its default app), open_app and list_apps (launch apps), and \
run_applescript (control Mac apps — create a note, add a reminder/calendar event, get a URL, \
etc.; the first time you control an app macOS asks Andres to allow it), and system_control for \
the Mac's own settings — volume (turn down/up, set a level, mute/unmute the WHOLE Mac), screen \
brightness, media play/pause and next/previous track, sleeping the display, and locking the \
screen. When Andres says 'turn it down', 'lower the volume', 'mute', 'pause the music', 'lock my \
screen', use system_control (NOT run_applescript). Note: the 🔇 button only mutes the avatar's \
own voice — system_control mute silences the whole Mac. Confirm before sleep_display or \
lock_screen. For any action that SENDS, posts, deletes, or messages on Andres' behalf, confirm \
with him in your reply before doing it. \
CRITICAL: to actually use a tool you MUST emit a tool call. NEVER write that you searched, \
found, opened, scheduled, sent, or will do something unless you truly called the tool in THIS \
turn and saw its result. Do not narrate intentions ('I'll search…', 'let me open it') or \
invent results (dates, filenames, headlines) — if a request needs a tool, call it now; if you \
cannot, say so plainly. \
Ground every factual claim in tool results; if the tools return nothing relevant, say so \
plainly rather than guessing. Keep spoken answers short enough to listen to (unless asked to \
read a file verbatim)."
        .into()
}

/// Thread-safe settings handle stored in Tauri state.
pub struct SettingsState(pub Mutex<Settings>);

fn settings_path(app: &AppHandle) -> std::io::Result<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("settings.json"))
}

pub fn load(app: &AppHandle) -> Settings {
    match settings_path(app).and_then(std::fs::read_to_string) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

pub fn save(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app).map_err(|e| e.to_string())?;
    let raw = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(path, raw).map_err(|e| e.to_string())
}

/// The macOS path where the Tauri app persists settings.json. The headless
/// brain-daemon reads the SAME file (no AppHandle available), so it uses exactly
/// the keys/paths Andres configured in the app's Settings UI.
pub fn config_file_path() -> PathBuf {
    let home = dirs_home();
    PathBuf::from(format!(
        "{home}/Library/Application Support/com.moil.brainavatar/settings.json"
    ))
}

/// Load settings without a Tauri AppHandle (for the brain-daemon binary).
pub fn load_standalone() -> Settings {
    match std::fs::read_to_string(config_file_path()) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

/// PATH that includes the dirs where node / bun / homebrew tools live, so the
/// bundled app (which inherits a minimal PATH) can still spawn gbrain & m365.
pub fn augmented_path() -> String {
    let home = dirs_home();
    let extra = [
        "/opt/homebrew/bin".to_string(),
        format!("{home}/.bun/bin"),
        "/usr/local/bin".to_string(),
        "/usr/bin".to_string(),
        "/bin".to_string(),
    ];
    let existing = std::env::var("PATH").unwrap_or_default();
    format!("{}:{}", extra.join(":"), existing)
}
