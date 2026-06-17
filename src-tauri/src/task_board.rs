// Per-conversation kanban task board — durable, offline, survives app updates.
// Lives in the app config dir as task_boards.json, alongside conversations.json
// (history.rs). This is the structural fix for the "model narrates a plan but
// never executes it" failure: the agent loop forces a real, persisted, evidence-
// bearing board instead of letting the model queue work in prose and drop it.
//
// Design notes:
//  - Whole-board overwrite (TodoWrite-style): the agent re-reads the board each
//    round and re-emits the full task list. The server owns timestamps and
//    attempt_count so the model cannot rewrite history.
//  - A `set` is rejected (Err) when a card is Done with no evidence, or Blocked
//    with no blocker reason — the error string is phrased for the agent to read
//    and self-correct on the next round.
//  - Atomic write via <path>.tmp + rename so a crash mid-write never truncates
//    the file (the gap history.rs has; not inherited here).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

const CURRENT_SCHEMA_VERSION: u32 = 1;

/// Serializes all task-board file I/O across the four commands. Tauri runs
/// command handlers on a worker pool, so the agent loop's `set_task_board`
/// could race the UI's `get_task_board` on the whole-file rewrite. Reads take
/// the lock too, so a save mid-deserialize can never serve a half-written file
/// (belt-and-suspenders with the atomic temp-file rename). Contention is
/// irrelevant — kanban writes are human-paced.
static FILE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    #[default]
    Todo,
    InProgress,
    Done,
    Blocked,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Task {
    pub id: String,                       // stable id; server-assigned when input id is empty
    pub title: String,                    // human-readable line item
    pub status: TaskStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence: Option<String>, // required (non-empty) when status == Done
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocker: Option<String>, // required (non-empty) when status == Blocked
    pub created_at: String,               // RFC3339, server-assigned
    pub updated_at: String,               // RFC3339, server-bumped on any field change
    #[serde(default)]
    pub attempt_count: u32, // bumped each (todo|blocked)->in_progress transition
}

/// Wire-shape the agent sends to `set_task_board`. The server fills the rest —
/// created_at/updated_at/attempt_count are deliberately absent so the model
/// cannot forge them.
#[derive(Deserialize, Clone, Debug)]
pub struct TaskInput {
    #[serde(default)]
    pub id: String, // empty => server assigns a stable id
    pub title: String,
    pub status: TaskStatus,
    #[serde(default)]
    pub evidence: Option<String>,
    #[serde(default)]
    pub blocker: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Board {
    pub conversation_id: String,
    pub updated_at: String,
    pub tasks: Vec<Task>,
    #[serde(default)]
    pub version: u64, // monotonic per-board counter; UI change detection
}

#[derive(Serialize, Deserialize, Debug)]
pub struct TaskBoardStore {
    #[serde(default = "default_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub boards: Vec<Board>,
}

fn default_version() -> u32 {
    CURRENT_SCHEMA_VERSION
}

impl Default for TaskBoardStore {
    fn default() -> Self {
        Self {
            schema_version: CURRENT_SCHEMA_VERSION,
            boards: Vec::new(),
        }
    }
}

#[derive(Serialize, Debug)]
pub struct BoardSummary {
    pub conversation_id: String,
    pub updated_at: String,
    pub total: usize,
    pub todo: usize,
    pub in_progress: usize,
    pub done: usize,
    pub blocked: usize,
}

// ---- path + I/O helpers (mirror history.rs) ----

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("task_boards.json"))
}

fn load_store_at(path: &std::path::Path) -> TaskBoardStore {
    match std::fs::read_to_string(path) {
        Ok(raw) => migrate_if_needed(serde_json::from_str(&raw).unwrap_or_default()),
        Err(_) => TaskBoardStore::default(),
    }
}

/// Atomic write: serialize -> write to <path>.tmp -> rename onto target. POSIX
/// rename is atomic on the same filesystem, so a crash never leaves a truncated
/// task_boards.json.
fn save_store_at(path: &std::path::Path, store: &TaskBoardStore) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    let raw = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, raw).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn load_store(app: &AppHandle) -> TaskBoardStore {
    match store_path(app) {
        Ok(p) => load_store_at(&p),
        Err(_) => TaskBoardStore::default(),
    }
}

fn save_store(app: &AppHandle, store: &TaskBoardStore) -> Result<(), String> {
    let p = store_path(app)?;
    save_store_at(&p, store)
}

fn migrate_if_needed(store: TaskBoardStore) -> TaskBoardStore {
    // Forward-only migration ladder. Future schema bumps add arms here. A file
    // newer than this build is left untouched; set_task_board refuses to write
    // over it so a downgrade can't silently corrupt newer data.
    store
}

/// Pure reconcile step — no Tauri, no I/O — so it can be unit-tested directly.
/// Collapses extra `in_progress` cards to `todo` (first wins), enforces the
/// evidence/blocker invariants, assigns ids to new cards, and carries forward
/// server-owned fields (created_at / updated_at / attempt_count) by diffing
/// against the existing tasks.
fn reconcile_tasks(
    existing: &[Task],
    inputs: Vec<TaskInput>,
    now: &str,
    now_millis: i64,
) -> Result<Vec<Task>, String> {
    // 1. Collapse: at most one card may be in_progress. First in input order wins;
    //    later in_progress cards fall back to todo. Keeps the board's "one thing
    //    at a time" discipline even if the model over-claims.
    let mut seen_in_progress = false;
    let inputs: Vec<TaskInput> = inputs
        .into_iter()
        .map(|mut inp| {
            if matches!(inp.status, TaskStatus::InProgress) {
                if seen_in_progress {
                    inp.status = TaskStatus::Todo;
                } else {
                    seen_in_progress = true;
                }
            }
            inp
        })
        .collect();

    // 2. Invariant guards. The label prefers the id, falling back to the title so
    //    the agent-facing error names the offending card.
    for inp in &inputs {
        let label = if inp.id.trim().is_empty() {
            inp.title.as_str()
        } else {
            inp.id.as_str()
        };
        if matches!(inp.status, TaskStatus::Done)
            && inp.evidence.as_deref().map(str::trim).unwrap_or("").is_empty()
        {
            return Err(format!(
                "Task '{label}' marked done without evidence. Supply an evidence string \
                 naming the tool you called this turn and what it returned."
            ));
        }
        if matches!(inp.status, TaskStatus::Blocked)
            && inp.blocker.as_deref().map(str::trim).unwrap_or("").is_empty()
        {
            return Err(format!(
                "Task '{label}' marked blocked without a 'blocker' reason. Say what is needed to unblock it."
            ));
        }
    }

    // 3. Diff against existing: preserve created_at + attempt_count, bump
    //    updated_at on change, bump attempt_count when a card enters in_progress.
    let mut out: Vec<Task> = Vec::with_capacity(inputs.len());
    for (idx, inp) in inputs.into_iter().enumerate() {
        let id = if inp.id.trim().is_empty() {
            format!("t_{now_millis}_{idx}")
        } else {
            inp.id
        };
        let prior = existing.iter().find(|t| t.id == id);
        let (created_at, mut attempt_count, prior_status, changed) = match prior {
            Some(p) => (
                p.created_at.clone(),
                p.attempt_count,
                Some(p.status),
                p.title != inp.title || p.status != inp.status || p.evidence != inp.evidence
                    || p.blocker != inp.blocker,
            ),
            None => (now.to_string(), 0, None, true),
        };
        let entering_in_progress = matches!(inp.status, TaskStatus::InProgress)
            && prior_status.map_or(true, |s| !matches!(s, TaskStatus::InProgress));
        if entering_in_progress {
            attempt_count = attempt_count.saturating_add(1);
        }
        let updated_at = if changed {
            now.to_string()
        } else {
            prior.map(|p| p.updated_at.clone()).unwrap_or_else(|| now.to_string())
        };
        out.push(Task {
            id,
            title: inp.title,
            status: inp.status,
            evidence: inp.evidence,
            blocker: inp.blocker,
            created_at,
            updated_at,
            attempt_count,
        });
    }
    Ok(out)
}

// ---- Tauri commands ----

/// Full board for one conversation, or None if it has never had one.
#[tauri::command]
pub fn get_task_board(app: AppHandle, conversation_id: String) -> Option<Board> {
    let _g = FILE_LOCK.lock().unwrap();
    let store = load_store(&app);
    // Symmetric with set_task_board: if the file was written by a NEWER schema (a
    // downgrade), Serde silently drops unknown fields and would hand back a
    // truncated board. Refuse to serve it rather than show wrong data.
    if store.schema_version > CURRENT_SCHEMA_VERSION {
        return None;
    }
    store
        .boards
        .into_iter()
        .find(|b| b.conversation_id == conversation_id)
}

/// Overwrite a conversation's board with the supplied task list. Returns the
/// reconciled board (server-assigned ids/timestamps) so the caller can render
/// the canonical state. Errors are model-readable so the agent loop can recover.
#[tauri::command]
pub fn set_task_board(
    app: AppHandle,
    conversation_id: String,
    tasks: Vec<TaskInput>,
) -> Result<Board, String> {
    let _g = FILE_LOCK.lock().unwrap();
    let mut store = load_store(&app);
    if store.schema_version > CURRENT_SCHEMA_VERSION {
        return Err(format!(
            "task_boards.json schema version {} is newer than this build ({}). \
             Refusing to overwrite to avoid data loss.",
            store.schema_version, CURRENT_SCHEMA_VERSION
        ));
    }

    let now_dt = chrono::Utc::now();
    let now = now_dt.to_rfc3339();
    let now_millis = now_dt.timestamp_millis();

    let existing_idx = store
        .boards
        .iter()
        .position(|b| b.conversation_id == conversation_id);
    let existing_tasks: Vec<Task> = existing_idx
        .map(|i| store.boards[i].tasks.clone())
        .unwrap_or_default();
    let prior_version = existing_idx.map(|i| store.boards[i].version).unwrap_or(0);

    let new_tasks = reconcile_tasks(&existing_tasks, tasks, &now, now_millis)?;

    let board = Board {
        conversation_id: conversation_id.clone(),
        updated_at: now,
        tasks: new_tasks,
        version: prior_version.saturating_add(1),
    };

    match existing_idx {
        Some(i) => store.boards[i] = board.clone(),
        None => store.boards.push(board.clone()),
    }
    store.schema_version = CURRENT_SCHEMA_VERSION;
    save_store(&app, &store)?;
    Ok(board)
}

/// Lightweight per-board counts (no task bodies), newest first — for a future
/// "boards from other conversations" picker.
#[tauri::command]
pub fn list_task_boards(app: AppHandle) -> Vec<BoardSummary> {
    let _g = FILE_LOCK.lock().unwrap();
    let mut store = load_store(&app);
    store.boards.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    store
        .boards
        .into_iter()
        .map(|b| {
            let mut s = BoardSummary {
                conversation_id: b.conversation_id,
                updated_at: b.updated_at,
                total: b.tasks.len(),
                todo: 0,
                in_progress: 0,
                done: 0,
                blocked: 0,
            };
            for t in &b.tasks {
                match t.status {
                    TaskStatus::Todo => s.todo += 1,
                    TaskStatus::InProgress => s.in_progress += 1,
                    TaskStatus::Done => s.done += 1,
                    TaskStatus::Blocked => s.blocked += 1,
                }
            }
            s
        })
        .collect()
}

/// Remove a conversation's board entirely (used when the user abandons a plan).
#[tauri::command]
pub fn clear_task_board(app: AppHandle, conversation_id: String) -> Result<(), String> {
    let _g = FILE_LOCK.lock().unwrap();
    let mut store = load_store(&app);
    store.boards.retain(|b| b.conversation_id != conversation_id);
    save_store(&app, &store)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(id: &str, title: &str, status: TaskStatus) -> TaskInput {
        TaskInput {
            id: id.to_string(),
            title: title.to_string(),
            status,
            evidence: None,
            blocker: None,
        }
    }

    #[test]
    fn done_without_evidence_is_rejected() {
        let inputs = vec![input("t1", "do thing", TaskStatus::Done)];
        let err = reconcile_tasks(&[], inputs, "now", 0).unwrap_err();
        assert!(err.contains("without evidence"), "{err}");
    }

    #[test]
    fn done_with_evidence_is_accepted() {
        let mut t = input("t1", "do thing", TaskStatus::Done);
        t.evidence = Some("brain_page returned Josh page".into());
        let out = reconcile_tasks(&[], vec![t], "now", 0).unwrap();
        assert_eq!(out[0].status, TaskStatus::Done);
    }

    #[test]
    fn blocked_without_blocker_is_rejected() {
        let inputs = vec![input("t1", "do thing", TaskStatus::Blocked)];
        let err = reconcile_tasks(&[], inputs, "now", 0).unwrap_err();
        assert!(err.contains("without a 'blocker'"), "{err}");
    }

    #[test]
    fn extra_in_progress_collapses_to_todo() {
        let inputs = vec![
            input("t1", "a", TaskStatus::InProgress),
            input("t2", "b", TaskStatus::InProgress),
            input("t3", "c", TaskStatus::InProgress),
        ];
        let out = reconcile_tasks(&[], inputs, "now", 0).unwrap();
        assert_eq!(out[0].status, TaskStatus::InProgress);
        assert_eq!(out[1].status, TaskStatus::Todo);
        assert_eq!(out[2].status, TaskStatus::Todo);
    }

    #[test]
    fn attempt_count_bumps_on_entering_in_progress() {
        // First set: card starts as todo.
        let s1 = reconcile_tasks(&[], vec![input("t1", "a", TaskStatus::Todo)], "now", 0).unwrap();
        assert_eq!(s1[0].attempt_count, 0);
        // Next set: moves to in_progress -> attempt 1.
        let s2 = reconcile_tasks(&s1, vec![input("t1", "a", TaskStatus::InProgress)], "now", 0).unwrap();
        assert_eq!(s2[0].attempt_count, 1);
        // Staying in_progress: no bump.
        let s3 = reconcile_tasks(&s2, vec![input("t1", "a", TaskStatus::InProgress)], "now", 0).unwrap();
        assert_eq!(s3[0].attempt_count, 1);
        // Bounces to todo then back to in_progress -> attempt 2.
        let s4 = reconcile_tasks(&s3, vec![input("t1", "a", TaskStatus::Todo)], "now", 0).unwrap();
        let s5 = reconcile_tasks(&s4, vec![input("t1", "a", TaskStatus::InProgress)], "now", 0).unwrap();
        assert_eq!(s5[0].attempt_count, 2);
    }

    #[test]
    fn store_roundtrips_on_disk_with_atomic_write() {
        let mut path = std::env::temp_dir();
        path.push(format!("task_boards_rt_{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);

        let tasks = reconcile_tasks(
            &[],
            vec![
                TaskInput {
                    id: "".into(),
                    title: "Find Josh".into(),
                    status: TaskStatus::Done,
                    evidence: Some("brain_page returned Josh page".into()),
                    blocker: None,
                },
                TaskInput {
                    id: "".into(),
                    title: "Rewrite slide 27".into(),
                    status: TaskStatus::InProgress,
                    evidence: None,
                    blocker: None,
                },
            ],
            "t0",
            7,
        )
        .unwrap();
        let store = TaskBoardStore {
            schema_version: CURRENT_SCHEMA_VERSION,
            boards: vec![Board {
                conversation_id: "c1".into(),
                updated_at: "t0".into(),
                tasks,
                version: 1,
            }],
        };

        save_store_at(&path, &store).unwrap();
        // Atomic write leaves no .tmp behind and a valid target file.
        assert!(!path.with_extension("json.tmp").exists(), "tmp must be renamed away");
        assert!(path.exists());

        let back = load_store_at(&path);
        assert_eq!(back.schema_version, CURRENT_SCHEMA_VERSION);
        assert_eq!(back.boards.len(), 1);
        let b = &back.boards[0];
        assert_eq!(b.conversation_id, "c1");
        assert_eq!(b.tasks.len(), 2);
        assert_eq!(b.tasks[0].title, "Find Josh");
        assert_eq!(b.tasks[0].status, TaskStatus::Done);
        assert_eq!(b.tasks[0].evidence.as_deref(), Some("brain_page returned Josh page"));
        assert_eq!(b.tasks[1].status, TaskStatus::InProgress);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn corrupt_file_loads_as_default_without_panic() {
        let mut path = std::env::temp_dir();
        path.push(format!("task_boards_corrupt_{}.json", std::process::id()));
        std::fs::write(&path, b"{ not valid json ]]").unwrap();
        let store = load_store_at(&path); // serde unwrap_or_default — must not panic
        assert_eq!(store.boards.len(), 0);
        assert_eq!(store.schema_version, CURRENT_SCHEMA_VERSION);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn empty_id_gets_assigned_and_created_at_preserved() {
        let s1 = reconcile_tasks(&[], vec![input("", "a", TaskStatus::Todo)], "t0", 123).unwrap();
        assert_eq!(s1[0].id, "t_123_0");
        assert_eq!(s1[0].created_at, "t0");
        // Re-set with the assigned id at a later time: created_at must NOT change.
        let s2 = reconcile_tasks(&s1, vec![input("t_123_0", "a", TaskStatus::InProgress)], "t1", 456).unwrap();
        assert_eq!(s2[0].created_at, "t0");
        assert_eq!(s2[0].updated_at, "t1");
    }
}
