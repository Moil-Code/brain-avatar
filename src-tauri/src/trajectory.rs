use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

// ---------------------------------------------------------------------------
// On-device training corpus. Every completed turn is appended as ONE JSON line
// to a daily shard (trajectories/YYYY-MM-DD.jsonl) in the app config dir. This
// is the data an SFT/KTO fine-tune of the fast tier needs: the exact messages
// the model saw, the tool calls it chose, whether each succeeded, the route that
// ran it, and (later) the user's thumbs rating.
//
// Deliberately LOCAL-ONLY — never synced to Supabase/Vercel — so real transcripts
// (people, deals, emails) never leave the Mac. A redaction pass happens later, at
// export time, not here: capture stays faithful so nothing is silently lost.
// ---------------------------------------------------------------------------

/// One tool the model invoked this turn. `arguments` is the raw JSON string the
/// model emitted (kept verbatim, malformed or not — that's training signal too).
/// `ok` is false when the executor returned a "Tool X failed"/"Unknown tool"
/// result, so the exporter can keep only successful trajectories for SFT.
#[derive(Serialize, Deserialize, Clone)]
pub struct ToolEvent {
    pub round: u32,
    pub name: String,
    pub arguments: String,
    pub ok: bool,
}

/// A full captured turn. `messages` is the OpenAI-style array the model actually
/// saw (system + history + user + assistant tool_calls + tool results), stored as
/// raw JSON so the exporter can reshape it into MLX-LM's chat/tools format without
/// this layer needing to know that format.
#[derive(Serialize, Deserialize, Clone)]
pub struct Trajectory {
    pub schema_version: u32,
    pub conversation_id: String,
    /// The assistant UI message id — the join key the thumbs rating updates.
    pub turn_id: String,
    pub created_at: String,
    pub model_id: String,
    pub task_type: String,
    pub routed: bool,
    pub user: String,
    pub messages: serde_json::Value,
    pub tool_events: Vec<ToolEvent>,
    pub tools_used: Vec<String>,
    pub rounds: u32,
    pub final_answer: String,
    /// KTO label: -1/1 once the user rates the turn; None until then.
    #[serde(default)]
    pub rating: Option<i8>,
    /// Provenance so the exporter can mix/weight sources: "live" (real usage),
    /// "synthetic" (generated), "distilled" (teacher model). Live capture omits it
    /// → defaults to "live".
    #[serde(default = "default_source")]
    pub source: String,
}

fn default_source() -> String {
    "live".into()
}

fn traj_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("trajectories");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn day_of(ts: &str) -> &str {
    ts.get(0..10).unwrap_or("unknown")
}

/// Append one captured turn to today's shard. Best-effort: a write failure is
/// returned but the caller treats it as non-fatal to the chat.
#[tauri::command]
pub fn save_trajectory(app: AppHandle, trajectory: Trajectory) -> Result<(), String> {
    let path = traj_dir(&app)?.join(format!("{}.jsonl", day_of(&trajectory.created_at)));
    let line = serde_json::to_string(&trajectory).map_err(|e| e.to_string())?;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    writeln!(f, "{line}").map_err(|e| e.to_string())
}

/// Attach a thumbs rating to an already-captured turn (the KTO preference label).
/// Scans the daily shards for the line whose `turn_id` matches and rewrites it in
/// place. Best-effort: an unknown turn_id is a silent no-op (the turn may predate
/// capture, or sync may not have flushed yet).
#[tauri::command]
pub fn rate_trajectory(app: AppHandle, turn_id: String, rating: i8) -> Result<(), String> {
    if rating != -1 && rating != 1 {
        return Err("rating must be -1 or 1".into());
    }
    let dir = traj_dir(&app)?;
    let entries = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        if !raw.contains(&turn_id) {
            continue; // cheap pre-filter before the per-line parse
        }
        let mut out = String::with_capacity(raw.len() + 16);
        let mut hit = false;
        for line in raw.lines() {
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<Trajectory>(line) {
                Ok(mut t) if t.turn_id == turn_id => {
                    t.rating = Some(rating);
                    out.push_str(&serde_json::to_string(&t).map_err(|e| e.to_string())?);
                    out.push('\n');
                    hit = true;
                }
                _ => {
                    out.push_str(line);
                    out.push('\n');
                }
            }
        }
        if hit {
            std::fs::write(&path, out).map_err(|e| e.to_string())?;
            return Ok(());
        }
    }
    Ok(())
}
