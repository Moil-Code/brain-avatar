#!/usr/bin/env bash
# Hands-off, readiness-gated training. Trains ONLY when enough NEW turns have been
# captured since the last run (same 50-live / 15-rated bar as the in-app notify) —
# otherwise it no-ops. Two ways to use it:
#
#   • By hand, whenever:   bash training/auto-train.sh
#       Trains if ready, else prints how many more turns are needed. This is the
#       "let me hit it when 50 are reached" button — except it's safe to run any
#       time, because it checks first.
#
#   • Hands-off / automatic: schedule it (launchd — see training/README.md). Run it
#       overnight so a heavy 12B run never competes with the live avatar for RAM.
#
# Config: put BASE_MODEL (+ optional LMSTUDIO_URL / MODEL / MODE / NUM_LAYERS /
# EXPORT_GGUF) in training/train.env — sourced here so the scheduled job has them
# without editing any plist. See training/train.env.example.

set -euo pipefail
cd "$(dirname "$0")/.."

# Load saved config (BASE_MODEL etc.) if present. Not required for the dry check.
if [[ -f training/train.env ]]; then
  # shellcheck disable=SC1091
  set -a; source training/train.env; set +a
fi

echo "==> Checking training readiness…"
if node --experimental-strip-types training/readiness.ts; then
  echo "==> Ready — starting a training run."
  exec bash training/train.sh
else
  echo "==> Skipping: not enough new data yet. Nothing to do."
  exit 0
fi
