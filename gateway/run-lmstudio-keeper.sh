#!/bin/bash
# lmstudio-keeper — the missing supervisor for the brain chain on the 24GB Mac.
#
# launchd (KeepAlive) already restarts the brain-daemon and the lm-queue-proxy if
# they crash, but NOTHING supervised LM Studio itself — and LM Studio is the real
# single point of failure. After a reboot, a sleep, or an LM Studio restart the
# server can be down, or up with NO model loaded, and the whole avatar goes silent
# until a human notices.
#
# This keeper closes that gap. It loops forever and, every interval, GUARANTEES:
#   1. Tailscale is up          (so the tailnet path the daemon binds to exists)
#   2. LM Studio server is up    (`lms server start` if /v1/models doesn't answer)
#   3. A chat model is loaded    (`lms load` the default if none is loaded)
#   4. The lm-queue-proxy is up  (launchctl kickstart if :1235 doesn't answer)
#   5. The brain-daemon is up    (launchctl kickstart if its /health doesn't answer)
#
# It trusts the HTTP endpoints as ground truth (not `lms ps` text parsing), so it
# self-corrects a "process is running but wedged" state that KeepAlive can't see.
#
# Idempotent and GUI-safe: `lms server start` / `lms load` no-op when already
# satisfied, so running LM Studio's GUI alongside this is fine.
#
# Run it under launchd with KeepAlive (see com.moil.lmstudio-keeper.plist) so the
# loop itself is restarted if it ever dies.
#
# Config via env (all optional):
#   LMS_BIN             path to the `lms` CLI         (default: PATH, then ~/.lmstudio/bin/lms)
#   LMS_UPSTREAM        LM Studio base URL            (default http://127.0.0.1:1234)
#   LMS_DEFAULT_MODEL   model key to auto-load        (default: empty = don't force-load)
#   LMS_GPU             GPU offload for `lms load`    (default max)
#   KEEPER_INTERVAL     seconds between checks        (default 20)
#   PROXY_URL           lm-queue-proxy base URL       (default http://127.0.0.1:1235; empty disables)
#   PROXY_LABEL         its launchd label             (default com.moil.lm-queue-proxy)
#   DAEMON_HEALTH_URL   brain-daemon /health URL      (default: empty = don't supervise here)
#   DAEMON_LABEL        its launchd label             (default com.moil.brainavatar.daemon)
#   TAILSCALE_BIN       path to tailscale             (default /usr/local/bin/tailscale)
#
# Note: do NOT use `set -e` — a transient curl/lms failure must not kill the loop.
set -uo pipefail

LMS_UPSTREAM="${LMS_UPSTREAM:-http://127.0.0.1:1234}"
LMS_UPSTREAM="${LMS_UPSTREAM%/}"
LMS_DEFAULT_MODEL="${LMS_DEFAULT_MODEL:-}"
LMS_GPU="${LMS_GPU:-max}"
KEEPER_INTERVAL="${KEEPER_INTERVAL:-20}"
PROXY_URL="${PROXY_URL-http://127.0.0.1:1235}"
PROXY_URL="${PROXY_URL%/}"
PROXY_LABEL="${PROXY_LABEL:-com.moil.lm-queue-proxy}"
DAEMON_HEALTH_URL="${DAEMON_HEALTH_URL-}"
DAEMON_LABEL="${DAEMON_LABEL:-com.moil.brainavatar.daemon}"
TAILSCALE="${TAILSCALE_BIN:-/usr/local/bin/tailscale}"
UID_NUM="$(id -u)"

# Resolve the lms CLI once. If it's missing we can still supervise the proxy and
# daemon (the launchctl path), so don't hard-exit — just disable the lms steps.
if [[ -n "${LMS_BIN:-}" && -x "${LMS_BIN}" ]]; then
  :
elif command -v lms >/dev/null 2>&1; then
  LMS_BIN="$(command -v lms)"
elif [[ -x "$HOME/.lmstudio/bin/lms" ]]; then
  LMS_BIN="$HOME/.lmstudio/bin/lms"
else
  LMS_BIN=""
fi

log() { printf '[lmstudio-keeper] %s %s\n' "$(date '+%H:%M:%S')" "$*"; }

# True if the URL answers /v1/models within 5s.
reachable() { curl -fsS --max-time 5 "$1/v1/models" >/dev/null 2>&1; }

# 0 = a non-embedding model is loaded, 1 = none loaded, 2 = couldn't tell.
chat_model_loaded() {
  local body
  body="$(curl -fsS --max-time 5 "$LMS_UPSTREAM/api/v0/models" 2>/dev/null)" || return 2
  printf '%s' "$body" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(2)
arr = data.get("data") if isinstance(data, dict) else data
def loaded(m):
    return (isinstance(m, dict) and m.get("state") == "loaded"
            and m.get("type") not in ("embeddings", "embedding"))
sys.exit(0 if any(loaded(m) for m in (arr or [])) else 1)
' 2>/dev/null
}

lms() { [[ -n "$LMS_BIN" ]] && "$LMS_BIN" "$@" >/dev/null 2>&1; }

ensure_tailscale() {
  "$TAILSCALE" ip -4 >/dev/null 2>&1 && return 0
  log "tailscale down — bringing it up"
  "$TAILSCALE" up >/dev/null 2>&1 || log "could not bring tailscale up (check auth)"
}

ensure_lmstudio() {
  if ! reachable "$LMS_UPSTREAM"; then
    if [[ -z "$LMS_BIN" ]]; then
      log "LM Studio unreachable and no \`lms\` CLI found — cannot auto-start it"
      return
    fi
    log "LM Studio server not responding — \`lms server start\`"
    lms server start
    sleep 3
  fi
  reachable "$LMS_UPSTREAM" || return  # still down; try again next loop

  chat_model_loaded
  case $? in
    0) : ;;  # a chat model is loaded — nothing to do
    1)
      if [[ -n "$LMS_DEFAULT_MODEL" && -n "$LMS_BIN" ]]; then
        log "no chat model loaded — \`lms load $LMS_DEFAULT_MODEL\`"
        lms load "$LMS_DEFAULT_MODEL" -y --gpu "$LMS_GPU"
      elif [[ -z "$LMS_DEFAULT_MODEL" ]]; then
        log "no chat model loaded and LMS_DEFAULT_MODEL unset — leaving as-is"
      fi
      ;;
    *) : ;;  # couldn't tell (no /api/v0 support); server is up, leave it
  esac
}

# Restart a launchd-managed service if its health URL doesn't answer.
ensure_service() {
  local label="$1" url="$2"
  [[ -z "$url" ]] && return 0
  if ! curl -fsS --max-time 5 "$url" >/dev/null 2>&1; then
    log "$label unreachable at $url — launchctl kickstart"
    launchctl kickstart -k "gui/$UID_NUM/$label" >/dev/null 2>&1 \
      || log "kickstart failed for $label (is its plist loaded?)"
  fi
}

log "starting — upstream $LMS_UPSTREAM, interval ${KEEPER_INTERVAL}s, lms=${LMS_BIN:-<none>}"
while true; do
  ensure_tailscale
  ensure_lmstudio
  [[ -n "$PROXY_URL" ]] && ensure_service "$PROXY_LABEL" "$PROXY_URL/v1/models"
  [[ -n "$DAEMON_HEALTH_URL" ]] && ensure_service "$DAEMON_LABEL" "$DAEMON_HEALTH_URL"
  sleep "$KEEPER_INTERVAL"
done
