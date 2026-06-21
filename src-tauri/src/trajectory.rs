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

// ---------------------------------------------------------------------------
// Stats for the in-app Training tracker. Aggregates the local trajectory shards
// (what we'd train on) and the training-run log (when we've trained).
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct Count {
    pub name: String,
    pub count: u32,
}

#[derive(Serialize, Default)]
pub struct Ratings {
    pub up: u32,
    pub down: u32,
    pub unrated: u32,
}

#[derive(Serialize, Default)]
pub struct TrajectoryStats {
    pub total: u32,
    pub by_source: Vec<Count>,
    pub by_task: Vec<Count>,
    pub by_tool: Vec<Count>,
    pub by_day: Vec<Count>,
    pub ratings: Ratings,
    /// Live (real-usage) turns — the highest-value training rows.
    pub live: u32,
    /// Live turns that carry a thumbs rating (the KTO-eligible signal).
    pub rated_live: u32,
}

/// Slim view of a record — only the fields the tracker aggregates, so a schema
/// change to the heavy `messages` payload never breaks stats parsing.
#[derive(Deserialize)]
struct StatRow {
    #[serde(default)]
    source: String,
    #[serde(default)]
    task_type: String,
    #[serde(default)]
    tools_used: Vec<String>,
    #[serde(default)]
    rating: Option<i8>,
    #[serde(default)]
    created_at: String,
}

fn tally(map: &std::collections::HashMap<String, u32>) -> Vec<Count> {
    let mut v: Vec<Count> = map
        .iter()
        .map(|(k, &count)| Count { name: k.clone(), count })
        .collect();
    v.sort_by(|a, b| b.count.cmp(&a.count).then(a.name.cmp(&b.name)));
    v
}

/// Aggregate the local trajectory corpus for the Training tracker. Empty-safe:
/// returns zeroes when no trajectories have been captured yet.
#[tauri::command]
pub fn trajectory_stats(app: AppHandle) -> Result<TrajectoryStats, String> {
    use std::collections::HashMap;
    let dir = traj_dir(&app)?;
    let mut s = TrajectoryStats::default();
    let (mut src, mut task, mut tool, mut day): (
        HashMap<String, u32>,
        HashMap<String, u32>,
        HashMap<String, u32>,
        HashMap<String, u32>,
    ) = Default::default();

    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(s); // dir not created yet → no data
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        for line in raw.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let Ok(r) = serde_json::from_str::<StatRow>(line) else {
                continue; // skip a malformed line rather than fail the whole view
            };
            s.total += 1;
            let source = if r.source.is_empty() { "live".to_string() } else { r.source };
            *src.entry(source.clone()).or_default() += 1;
            if !r.task_type.is_empty() {
                *task.entry(r.task_type).or_default() += 1;
            }
            for t in &r.tools_used {
                *tool.entry(t.clone()).or_default() += 1;
            }
            if r.created_at.len() >= 10 {
                *day.entry(r.created_at[..10].to_string()).or_default() += 1;
            }
            let is_live = source == "live";
            if is_live {
                s.live += 1;
            }
            match r.rating {
                Some(1) => {
                    s.ratings.up += 1;
                    if is_live {
                        s.rated_live += 1;
                    }
                }
                Some(-1) => {
                    s.ratings.down += 1;
                    if is_live {
                        s.rated_live += 1;
                    }
                }
                _ => s.ratings.unrated += 1,
            }
        }
    }

    s.by_source = tally(&src);
    s.by_task = tally(&task);
    s.by_tool = tally(&tool);
    // by_day sorted chronologically (ascending) for a growth timeline.
    let mut days = tally(&day);
    days.sort_by(|a, b| a.name.cmp(&b.name));
    s.by_day = days;
    Ok(s)
}

/// One training run, as appended by train.sh to training-runs.jsonl. All fields
/// optional so a partial/streaming write never breaks the list.
#[derive(Serialize, Deserialize, Default)]
pub struct TrainingRun {
    #[serde(default)]
    pub started_at: String,
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub base_model: String,
    #[serde(default)]
    pub iters: u32,
    #[serde(default)]
    pub examples: u32,
    #[serde(default)]
    pub eval_before: Option<f32>,
    #[serde(default)]
    pub eval_after: Option<f32>,
    #[serde(default)]
    pub adapter_path: String,
    #[serde(default)]
    pub status: String,
}

fn runs_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("training-runs.jsonl"))
}

/// The log of training runs (newest first) for the "when we train" timeline.
#[tauri::command]
pub fn list_training_runs(app: AppHandle) -> Result<Vec<TrainingRun>, String> {
    let path = runs_path(&app)?;
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Ok(vec![]);
    };
    let mut runs: Vec<TrainingRun> = raw
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<TrainingRun>(l).ok())
        .collect();
    runs.reverse(); // newest first
    Ok(runs)
}

/// Append a training run to the log. train.sh calls this path via the file directly;
/// this command lets the app (or a future "log run" action) record one too.
#[tauri::command]
pub fn log_training_run(app: AppHandle, run: TrainingRun) -> Result<(), String> {
    let path = runs_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let line = serde_json::to_string(&run).map_err(|e| e.to_string())?;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    writeln!(f, "{line}").map_err(|e| e.to_string())
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
