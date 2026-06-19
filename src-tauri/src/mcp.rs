//! Minimal MCP (Model Context Protocol) client.
//!
//! Brain spawns each configured server over stdio, speaks JSON-RPC 2.0
//! (newline-delimited) to list and call its tools, then shuts it down. A
//! per-call spawn keeps this simple and robust — no long-lived child-process
//! state to manage across async tasks — which matches the rest of the tool layer
//! ("launch a CLI, read the result, done"). The tradeoff is per-call startup
//! latency and no cross-call server session, acceptable for a personal assistant.

use crate::config::{augmented_path, McpServer, SettingsState};
use crate::tools::tool_log;
use serde_json::{json, Value};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tauri::State;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::time::timeout;

// Generous: the first `npx -y <server>` call downloads the package before it
// answers, which can take well over 30s on a cold cache.
const MCP_TIMEOUT: Duration = Duration::from_secs(60);

/// A live stdio connection to one MCP server, post-handshake.
struct Conn {
    child: Child,
    stdin: ChildStdin,
    reader: BufReader<ChildStdout>,
    next_id: i64,
}

impl Conn {
    /// Spawn the server and complete the MCP initialize handshake.
    async fn start(server: &McpServer) -> Result<Conn, String> {
        let mut cmd = Command::new(&server.command);
        cmd.args(&server.args)
            .env("PATH", augmented_path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null()) // discard server logs so a chatty server can't block us
            .kill_on_drop(true);
        for (k, v) in &server.env {
            cmd.env(k, v);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to launch MCP server '{}': {e}", server.name))?;
        let stdin = child.stdin.take().ok_or("MCP server has no stdin")?;
        let stdout = child.stdout.take().ok_or("MCP server has no stdout")?;
        let mut conn = Conn {
            child,
            stdin,
            reader: BufReader::new(stdout),
            next_id: 1,
        };
        conn.initialize().await?;
        Ok(conn)
    }

    async fn send(&mut self, msg: &Value) -> Result<(), String> {
        let mut line = serde_json::to_string(msg).map_err(|e| e.to_string())?;
        line.push('\n');
        self.stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("MCP write failed: {e}"))?;
        self.stdin
            .flush()
            .await
            .map_err(|e| format!("MCP flush failed: {e}"))?;
        Ok(())
    }

    /// Read newline-delimited JSON until a response with `id` arrives, skipping
    /// any notifications / log lines the server emits in between.
    async fn read_response(&mut self, id: i64) -> Result<Value, String> {
        loop {
            let mut line = String::new();
            let n = timeout(MCP_TIMEOUT, self.reader.read_line(&mut line))
                .await
                .map_err(|_| "MCP server timed out".to_string())?
                .map_err(|e| format!("MCP read failed: {e}"))?;
            if n == 0 {
                return Err("MCP server closed the connection".into());
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let v: Value = match serde_json::from_str(trimmed) {
                Ok(v) => v,
                Err(_) => continue, // ignore non-JSON noise on stdout
            };
            if v.get("id").and_then(|x| x.as_i64()) == Some(id) {
                if let Some(err) = v.get("error") {
                    return Err(format!("MCP error: {err}"));
                }
                return Ok(v.get("result").cloned().unwrap_or(Value::Null));
            }
            // Different id / a notification — keep reading.
        }
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
            .await?;
        self.read_response(id).await
    }

    async fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        self.send(&json!({ "jsonrpc": "2.0", "method": method, "params": params }))
            .await
    }

    async fn initialize(&mut self) -> Result<(), String> {
        let params = json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "brain-avatar", "version": env!("CARGO_PKG_VERSION") }
        });
        self.request("initialize", params).await?;
        self.notify("notifications/initialized", json!({})).await?;
        Ok(())
    }

    /// Best-effort teardown: killing the child (kill_on_drop also covers panics).
    async fn shutdown(mut self) {
        let _ = self.child.start_kill();
    }
}

/// List one server's tools (spawn → list → shut down).
async fn list_one(server: &McpServer) -> Result<Vec<Value>, String> {
    let mut conn = Conn::start(server).await?;
    let result = conn.request("tools/list", json!({})).await;
    conn.shutdown().await;
    let result = result?;
    Ok(result
        .get("tools")
        .and_then(|t| t.as_array())
        .cloned()
        .unwrap_or_default())
}

/// Flatten an MCP tools/call result's content blocks into a single string for
/// the model. Surfaces text blocks; names other block types; honors isError.
fn render_tool_result(result: &Value) -> String {
    let mut out = String::new();
    if let Some(items) = result.get("content").and_then(|c| c.as_array()) {
        for item in items {
            match item.get("type").and_then(|t| t.as_str()) {
                Some("text") => {
                    if let Some(t) = item.get("text").and_then(|t| t.as_str()) {
                        out.push_str(t);
                        out.push('\n');
                    }
                }
                Some(other) => out.push_str(&format!("[{other} content]\n")),
                None => {}
            }
        }
    }
    let is_error = result.get("isError").and_then(|b| b.as_bool()).unwrap_or(false);
    let body = out.trim();
    if body.is_empty() {
        return if is_error {
            "MCP tool returned an error with no message.".into()
        } else {
            "(no output)".into()
        };
    }
    if is_error {
        format!("MCP tool error: {body}")
    } else {
        body.to_string()
    }
}

/// Discover every enabled server's tools. Returns `{ tools: [...], errors: [...] }`
/// so the UI/agent can merge tools and still surface servers that failed to start.
#[tauri::command]
pub async fn mcp_list_tools(state: State<'_, SettingsState>) -> Result<Value, String> {
    let servers = { state.0.lock().unwrap().mcp_servers.clone() };
    let mut all: Vec<Value> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    for server in servers.iter().filter(|s| s.enabled) {
        match list_one(server).await {
            Ok(tools) => {
                for t in tools {
                    all.push(json!({
                        "server": server.name,
                        "name": t.get("name").cloned().unwrap_or(Value::Null),
                        "description": t.get("description").cloned().unwrap_or(Value::Null),
                        "inputSchema": t
                            .get("inputSchema")
                            .cloned()
                            .unwrap_or_else(|| json!({ "type": "object", "properties": {} })),
                    }));
                }
            }
            Err(e) => errors.push(format!("{}: {e}", server.name)),
        }
    }
    Ok(json!({ "tools": all, "errors": errors }))
}

/// Call a tool on a named, enabled server. `args` is the tool's argument object.
#[tauri::command]
pub async fn mcp_call_tool(
    server: String,
    tool: String,
    args: Value,
    state: State<'_, SettingsState>,
) -> Result<String, String> {
    let cfg = {
        state
            .0
            .lock()
            .unwrap()
            .mcp_servers
            .iter()
            .find(|s| s.name == server && s.enabled)
            .cloned()
    };
    let cfg = cfg.ok_or_else(|| format!("No enabled MCP server named '{server}'."))?;

    let started = Instant::now();
    let mut conn = Conn::start(&cfg).await?;
    let result = conn
        .request("tools/call", json!({ "name": tool, "arguments": args }))
        .await;
    conn.shutdown().await;
    let ms = started.elapsed().as_millis();
    match result {
        Ok(v) => {
            let is_err = v.get("isError").and_then(|b| b.as_bool()).unwrap_or(false);
            tool_log(
                "mcp",
                &tool,
                &server,
                if is_err { "tool_error" } else { "ok" },
                ms,
                None,
            );
            Ok(render_tool_result(&v))
        }
        Err(e) => {
            tool_log("mcp", &tool, &server, "error", ms, Some(&e));
            Err(e)
        }
    }
}

/// Settings "Test" button: probe one (possibly unsaved) server config and report
/// the tools it exposes.
#[tauri::command]
pub async fn mcp_probe(server: McpServer) -> Result<String, String> {
    let tools = list_one(&server).await?;
    let names: Vec<String> = tools
        .iter()
        .filter_map(|t| t.get("name").and_then(|n| n.as_str()).map(String::from))
        .collect();
    Ok(format!(
        "Connected to '{}' — {} tool(s){}",
        server.name,
        names.len(),
        if names.is_empty() {
            String::new()
        } else {
            format!(": {}", names.join(", "))
        }
    ))
}
