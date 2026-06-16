#!/bin/bash
# One-time setup for the brain-daemon on the Mac Mini (the brain owner).
# Generates a token, builds the release binary, and prints exactly what to enter
# in the MacBook app's Settings → Remote brain. Does NOT touch launchd — you load
# the plist manually (see the printed instructions).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG_DIR="$HOME/.config/brain-avatar"
TOKEN_FILE="$CFG_DIR/daemon-token"
PORT="${BRAIN_DAEMON_PORT:-8787}"
TAILSCALE="${TAILSCALE_BIN:-/usr/local/bin/tailscale}"

mkdir -p "$CFG_DIR"
if [[ -f "$TOKEN_FILE" ]]; then
  echo "Token already exists at $TOKEN_FILE — keeping it."
else
  ( umask 077; openssl rand -hex 32 > "$TOKEN_FILE" )
  chmod 600 "$TOKEN_FILE"
  echo "Generated a new daemon token at $TOKEN_FILE (chmod 600)."
fi

echo "Building the daemon (release)…"
( cd "$SCRIPT_DIR/../src-tauri" && cargo build --release --bin brain-daemon )

TS_IP="$("$TAILSCALE" ip -4 2>/dev/null | head -1 || true)"
PLIST="com.moil.brainavatar.daemon.plist"

echo
echo "==================== MacBook → Settings → Remote brain ===================="
echo "  Daemon URL:    http://${TS_IP:-<run: tailscale ip -4>}:$PORT"
echo "  Daemon token:  $(cat "$TOKEN_FILE")"
echo "==========================================================================="
echo
echo "Then install + load the LaunchAgent (you load plists manually):"
echo "  cp \"$SCRIPT_DIR/$PLIST\" ~/Library/LaunchAgents/"
echo "  launchctl load ~/Library/LaunchAgents/$PLIST"
echo
echo "Verify it's serving on the tailnet:"
echo "  curl -s http://${TS_IP:-<tailscale-ip>}:$PORT/health"
