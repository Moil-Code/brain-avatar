#!/bin/bash
# Wrapper launched by launchd (com.moil.brainavatar.daemon) on the Mac Mini.
# Reads the daemon token from a 0600 file (so it's never in the plist or in
# `ps`/process args) and binds to the Tailscale interface so the daemon is
# reachable ONLY over the tailnet — never the LAN or the public internet.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/../src-tauri/target/release/brain-daemon"
TOKEN_FILE="$HOME/.config/brain-avatar/daemon-token"
PORT="${BRAIN_DAEMON_PORT:-8787}"
TAILSCALE="${TAILSCALE_BIN:-/usr/local/bin/tailscale}"

if [[ ! -x "$BIN" ]]; then
  echo "brain-daemon not built at $BIN. Run: daemon/setup-daemon.sh" >&2
  exit 1
fi
if [[ ! -f "$TOKEN_FILE" ]]; then
  echo "No daemon token at $TOKEN_FILE. Run: daemon/setup-daemon.sh" >&2
  exit 1
fi

TS_IP="$("$TAILSCALE" ip -4 2>/dev/null | head -1 || true)"
if [[ -z "$TS_IP" ]]; then
  echo "Tailscale IP unavailable — is tailscale up? (\`tailscale status\`)" >&2
  exit 1
fi

export BRAIN_DAEMON_TOKEN="$(cat "$TOKEN_FILE")"
export BRAIN_DAEMON_BIND="$TS_IP:$PORT"
echo "Starting brain-daemon on $BRAIN_DAEMON_BIND (tailnet-only)"
exec "$BIN"
