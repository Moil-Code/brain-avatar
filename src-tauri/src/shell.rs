use crate::config::augmented_path;
use crate::tools::tool_log;
use std::time::{Duration, Instant};
use tokio::process::Command;
use tokio::time::timeout;

/// Shell commands can do real work (compiles, scripts, file moves), so give them
/// more room than a quick CLI lookup — but still bounded so a runaway command
/// can't hang the assistant forever.
const SHELL_TIMEOUT: Duration = Duration::from_secs(60);
/// Cap returned output so a chatty command can't blow up the model's context.
const MAX_OUTPUT_CHARS: usize = 6000;

/// A short, log-safe preview of a command (for the audit log target field).
fn cmd_preview(command: &str) -> String {
    command.replace('\n', " ").chars().take(80).collect()
}

/// HARD safety block — these never run, confirmation or not. This is the one
/// mitigation that prompt injection cannot talk its way past: the avatar reads
/// email and the web, so an attacker-controlled page could tell it to wipe a
/// disk, pipe a script from the internet into a shell, or read SSH keys. The
/// deny-list refuses those classes outright, in Rust, before anything executes.
/// (Confirmation + the model's prose check are the softer, model-side gates.)
fn deny_reason(command: &str) -> Option<String> {
    // Normalize: lowercase + collapse runs of whitespace, so "rm   -rf  /" and
    // "RM -rf /" match the same patterns.
    let norm = command.to_lowercase();
    let norm: String = norm.split_whitespace().collect::<Vec<_>>().join(" ");

    // (substring, human reason). Substrings are matched against the normalized
    // command, so spacing/casing variations are covered.
    const BLOCKED: &[(&str, &str)] = &[
        // Mass deletion of home/root/everything.
        ("rm -rf /", "recursive delete of a root-level path"),
        ("rm -rf ~", "recursive delete of the home directory"),
        ("rm -rf .", "recursive delete of the current/parent directory"),
        ("rm -rf *", "recursive delete of everything in a directory"),
        ("rm -fr /", "recursive delete of a root-level path"),
        ("rm -fr ~", "recursive delete of the home directory"),
        // Disk / filesystem destruction.
        ("mkfs", "formatting a filesystem"),
        ("dd if=", "raw disk write with dd"),
        ("dd of=/dev", "raw write to a device"),
        ("diskutil erase", "erasing a disk"),
        ("> /dev/", "writing directly to a device node"),
        (":(){", "a fork-bomb pattern"),
        // Pipe-the-internet-into-a-shell (the classic injection RCE).
        ("curl | sh", "piping a downloaded script straight into a shell"),
        ("curl|sh", "piping a downloaded script straight into a shell"),
        ("curl | bash", "piping a downloaded script straight into a shell"),
        ("curl|bash", "piping a downloaded script straight into a shell"),
        ("wget | sh", "piping a downloaded script straight into a shell"),
        ("wget|sh", "piping a downloaded script straight into a shell"),
        ("wget | bash", "piping a downloaded script straight into a shell"),
        ("wget|bash", "piping a downloaded script straight into a shell"),
        // Credential / secret exfiltration.
        ("id_rsa", "reading a private SSH key"),
        ("id_ed25519", "reading a private SSH key"),
        ("/.ssh/", "touching the SSH key directory"),
        (".aws/credentials", "reading AWS credentials"),
        ("dump-keychain", "dumping the macOS Keychain"),
        ("/etc/sudoers", "touching the sudoers file"),
        // Privilege escalation can't get a password non-interactively anyway, and
        // is a sharp edge we don't want the model reaching for.
        ("sudo ", "running with sudo (privilege escalation)"),
    ];

    for (needle, reason) in BLOCKED {
        // For the pipe-to-shell patterns we tolerate any spacing by also checking
        // the no-space form above; here a plain contains on the normalized command
        // is enough for the rest.
        if norm.contains(needle) {
            return Some((*reason).to_string());
        }
    }
    None
}

/// Run an arbitrary shell command on Andres' Mac. This is the broad "do almost
/// anything" lever, so it is gated three ways: a hard deny-list (above) that
/// blocks the highest-blast-radius / injection commands no matter what, an
/// explicit `confirm=true` the model must pass only after Andres says yes, and a
/// structured audit line for every attempt. Output (stdout+stderr) is capped.
#[tauri::command]
pub async fn run_shell(command: String, confirm: Option<bool>) -> Result<String, String> {
    let command = command.trim().to_string();
    if command.is_empty() {
        return Err("Empty command".into());
    }

    if let Some(reason) = deny_reason(&command) {
        tool_log("run_shell", "exec", &cmd_preview(&command), "denied", 0, Some(&reason));
        return Err(format!(
            "Refused to run this command — it involves {reason}. This is a hard safety block that \
             cannot be overridden. Tell Andres what was requested and why it was blocked."
        ));
    }

    if !confirm.unwrap_or(false) {
        return Ok(format!(
            "CONFIRMATION REQUIRED before running this shell command:\n\n    {command}\n\n\
             Show Andres EXACTLY this command and what it will do, wait for his explicit 'yes', \
             then call run_shell again with the same command and confirm=true. Do NOT set \
             confirm=true on your own — only after he approves."
        ));
    }

    let started = Instant::now();
    let exec = Command::new("/bin/sh")
        .arg("-c")
        .arg(&command)
        .env("PATH", augmented_path())
        .kill_on_drop(true)
        .output();
    let outcome = timeout(SHELL_TIMEOUT, exec).await;
    let ms = started.elapsed().as_millis();

    match outcome {
        Err(_) => {
            tool_log("run_shell", "exec", &cmd_preview(&command), "timeout", ms, Some("timed out"));
            Err(format!("Command timed out after {}s.", SHELL_TIMEOUT.as_secs()))
        }
        Ok(Err(e)) => {
            let msg = format!("failed to spawn shell: {e}");
            tool_log("run_shell", "exec", &cmd_preview(&command), "spawn_error", ms, Some(&msg));
            Err(msg)
        }
        Ok(Ok(out)) => {
            let code = out.status.code().unwrap_or(-1);
            let stdout = String::from_utf8_lossy(&out.stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);
            let ok = out.status.success();
            tool_log(
                "run_shell",
                "exec",
                &cmd_preview(&command),
                &format!("exit_{code}"),
                ms,
                if ok { None } else { Some(stderr.trim()) },
            );

            let mut body = String::new();
            if !stdout.trim().is_empty() {
                body.push_str(stdout.trim_end());
            }
            if !stderr.trim().is_empty() {
                if !body.is_empty() {
                    body.push_str("\n");
                }
                body.push_str("[stderr]\n");
                body.push_str(stderr.trim_end());
            }
            if body.is_empty() {
                body = "(no output)".to_string();
            }
            // Cap the output fed back to the model.
            let total = body.chars().count();
            if total > MAX_OUTPUT_CHARS {
                let kept: String = body.chars().take(MAX_OUTPUT_CHARS).collect();
                body = format!("{kept}\n\n[…truncated; {total} chars total…]");
            }
            Ok(format!("Command exited with code {code}.\n\n{body}"))
        }
    }
}
