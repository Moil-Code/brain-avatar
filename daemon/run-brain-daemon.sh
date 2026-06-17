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

# Pin the REAL LM Studio upstream (24GB Mac) here, independent of settings.json.
# The local avatar now points its `lm_studio_remote_url` at THIS daemon so its
# generations get serialized; if the daemon also read that field for its own
# upstream it would relay to itself. The real address + token live in the 0600
# secret (never in this public repo). MUST be the Tailscale IP, not Mac-mini.local
# — under launchd the .local/LAN path is blocked by Local Network privacy, but the
# tailnet (utun) is allowed. Once the lm-queue-proxy (gateway/) is deployed on the
# 24GB Mac, point LMSTUDIO_REMOTE_TAILNET_BASE at its :1235 instead of :1234.
LLM_SECRET="$HOME/.openclaw/secrets/lmstudio-remote.env"
if [[ -f "$LLM_SECRET" ]]; then
  # shellcheck disable=SC1090
  source "$LLM_SECRET"
  export BRAIN_DAEMON_LLM_TOKEN="${LMSTUDIO_REMOTE_TOKEN:-}"
fi
export BRAIN_DAEMON_LLM_URL="${BRAIN_DAEMON_LLM_URL:-${LMSTUDIO_REMOTE_TAILNET_BASE:-http://100.x.y.z:1234/v1}}"

echo "Starting brain-daemon on $BRAIN_DAEMON_BIND (tailnet-only); LLM upstream $BRAIN_DAEMON_LLM_URL"
exec "$BIN"
