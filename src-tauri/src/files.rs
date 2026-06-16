use crate::config::augmented_path;
use std::path::Path;
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;

const T: Duration = Duration::from_secs(25);

async fn run(program: &str, args: &[&str]) -> Result<String, String> {
    let out = timeout(
        T,
        Command::new(program)
            .args(args)
            .env("PATH", augmented_path())
            .output(),
    )
    .await
    .map_err(|_| format!("`{program}` timed out"))?
    .map_err(|e| format!("`{program}` failed: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(format!(
            "`{program}` error: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

/// Like `run`, but returns stdout regardless of exit code. `find`/`mdfind` print
/// valid results AND exit non-zero when some paths are permission-denied (TCC),
/// so we keep whatever they found.
async fn run_lenient(program: &str, args: &[&str]) -> String {
    match timeout(
        T,
        Command::new(program)
            .args(args)
            .env("PATH", augmented_path())
            .output(),
    )
    .await
    {
        Ok(Ok(out)) => String::from_utf8_lossy(&out.stdout).to_string(),
        _ => String::new(),
    }
}

/// Native recursive filename search. Case-insensitive substring match, bounded
/// depth + work, skips noise and permission-denied dirs (so it works without
/// Full Disk Access for non-protected files, and won't stall on protected ones).
fn walk_find(root: &str, query: &str, max: usize) -> Vec<String> {
    let needle = query.to_lowercase();
    if needle.is_empty() {
        return vec![];
    }
    let mut out: Vec<String> = Vec::new();
    let mut stack: Vec<(std::path::PathBuf, usize)> = vec![(std::path::PathBuf::from(root), 0)];
    let mut visited = 0usize;
    while let Some((dir, depth)) = stack.pop() {
        if out.len() >= max || visited > 15_000 {
            break;
        }
        visited += 1;
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue, // permission-denied / unreadable -> skip
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                if name.starts_with('.') || name == "node_modules" || name == "Library" {
                    continue;
                }
                if depth + 1 <= 4 {
                    stack.push((entry.path(), depth + 1));
                }
            }
            if name.to_lowercase().contains(&needle) {
                out.push(entry.path().to_string_lossy().to_string());
                if out.len() >= max {
                    break;
                }
            }
        }
    }
    out
}

fn expand_home(p: &str) -> String {
    if let Some(rest) = p.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return format!("{home}/{rest}");
        }
    }
    p.to_string()
}

/// Find files by name/content. Tries Spotlight (mdfind, content-aware) first, then
/// falls back to a direct filename `find` (Spotlight is often not indexing key dirs).
#[tauri::command]
pub async fn find_files(query: String, scope: Option<String>) -> Result<String, String> {
    if query.trim().is_empty() {
        return Err("Empty search query".into());
    }
    let dir = expand_home(
        &scope
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| std::env::var("HOME").unwrap_or_else(|_| "/Users".into())),
    );

    // 1) Spotlight (content + name) where indexed.
    let mut paths: Vec<String> = run_lenient("/usr/bin/mdfind", &["-onlyin", &dir, &query])
        .await
        .lines()
        .filter(|l| !l.is_empty())
        .map(|s| s.to_string())
        .collect();

    // 2) Fallback: native filename walk. Uses the same direct file access that
    //    works without Full Disk Access, and skips permission-denied dirs
    //    gracefully (a `find` subprocess stalls on TCC-protected dirs instead).
    if paths.is_empty() {
        let d = dir.clone();
        let q = query.trim().to_string();
        paths = tokio::task::spawn_blocking(move || walk_find(&d, &q, 40))
            .await
            .unwrap_or_default();
    }

    paths.truncate(20);
    if paths.is_empty() {
        return Ok(format!("No files found matching \"{query}\" under {dir}."));
    }
    let mut s = format!("Files matching \"{query}\" (top {}):\n", paths.len());
    for p in &paths {
        let name = Path::new(p).file_name().and_then(|n| n.to_str()).unwrap_or(p);
        s.push_str(&format!("• {name}\n    {p}\n"));
    }
    Ok(s)
}

/// Read a file's text content (plain text, Markdown, Word/RTF/HTML via textutil,
/// PDF via pdftotext if installed). Read-only.
#[tauri::command]
pub async fn read_file(path: String, max_chars: Option<usize>) -> Result<String, String> {
    let path = expand_home(&path);
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("File not found: {path}"));
    }
    let cap = max_chars.unwrap_or(8000);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let text = match ext.as_str() {
        "txt" | "md" | "markdown" | "text" | "csv" | "tsv" | "json" | "log" | "yaml" | "yml"
        | "toml" | "xml" | "" => {
            std::fs::read_to_string(p).map_err(|e| format!("read failed: {e}"))?
        }
        "rtf" | "rtfd" | "doc" | "docx" | "html" | "htm" | "odt" | "webarchive" => {
            run("/usr/bin/textutil", &["-convert", "txt", "-stdout", &path]).await?
        }
        "pdf" => match run("pdftotext", &[&path, "-"]).await {
            Ok(t) => t,
            Err(_) => {
                return Ok(format!(
                    "\"{path}\" is a PDF. Install pdftotext (`brew install poppler`) to read PDFs aloud, or I can open it for you instead."
                ))
            }
        },
        other => {
            return Ok(format!(
                "I can't read a .{other} file as text. I can open it in its default app instead."
            ))
        }
    };

    let total = text.chars().count();
    let body: String = text.chars().take(cap).collect();
    let note = if total > cap {
        format!("\n\n[…truncated; {total} chars total…]")
    } else {
        String::new()
    };
    Ok(format!("Contents of {path}:\n\n{body}{note}"))
}

/// Open a file or folder in its default application.
#[tauri::command]
pub async fn open_file(path: String) -> Result<String, String> {
    let path = expand_home(&path);
    if !Path::new(&path).exists() {
        return Err(format!("Path not found: {path}"));
    }
    run("/usr/bin/open", &[&path]).await?;
    Ok(format!("Opened {path}"))
}
