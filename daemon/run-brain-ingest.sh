#!/bin/bash
# Brain chat-inbox ingest — runs nightly at 23:00 via com.moil.brain-ingest.plist.
#
# Reads ~/.brain-chat-inbox/pushed.json (written by push_chat on any client device)
# and ingests the conversations into gbrain so MacBook chats are visible in the brain.
# On success, archives the inbox to prevent double-ingest on the next run.
#
# The gbrain ingest command below is a PLACEHOLDER — check `gbrain --help` or the
# gbrain docs and replace the commented-out line with the correct invocation.
#
# Install:
#   cp daemon/com.moil.brain-ingest.plist ~/Library/LaunchAgents/
#   launchctl load ~/Library/LaunchAgents/com.moil.brain-ingest.plist
# Run manually:
#   launchctl start com.moil.brain-ingest
#   # or directly:
#   bash daemon/run-brain-ingest.sh

set -uo pipefail

INBOX="$HOME/.brain-chat-inbox/pushed.json"
LOG="$HOME/Library/Logs/brain-ingest.log"
TIMESTAMP="$(date '+%Y-%m-%d %H:%M:%S')"
GBRAIN="${GBRAIN_BIN:-gbrain}"

echo "[$TIMESTAMP] brain-ingest starting" >> "$LOG"

if [[ ! -f "$INBOX" ]]; then
  echo "[$TIMESTAMP] No inbox at $INBOX — nothing to ingest" >> "$LOG"
  exit 0
fi

# Check the file has actual content (not just empty or a stub).
CONV_COUNT="$(python3 -c "
import json, sys
try:
    d = json.load(open('$INBOX'))
    print(len(d.get('conversations', [])))
except Exception:
    print(0)
" 2>/dev/null || echo 0)"

if [[ "$CONV_COUNT" == "0" ]]; then
  echo "[$TIMESTAMP] Inbox is empty — nothing to ingest" >> "$LOG"
  exit 0
fi

echo "[$TIMESTAMP] Found $CONV_COUNT conversation(s) to ingest" >> "$LOG"

# ---------------------------------------------------------------------------
# TODO: Replace the placeholder below with the actual gbrain ingest command.
#
# The pushed.json format is conversations.json-shaped:
#   { "conversations": [{ "id", "title", "messages": [{role, content, ts}] }] }
#
# Common gbrain ingest patterns (check `gbrain --help`):
#   "$GBRAIN" call ingest "$INBOX"
#   "$GBRAIN" ingest file "$INBOX"
#   "$GBRAIN" import chat "$INBOX"
# ---------------------------------------------------------------------------
# Uncomment the correct line once you know the gbrain ingest API:
# "$GBRAIN" call ingest "$INBOX" >> "$LOG" 2>&1

echo "[$TIMESTAMP] NOTE: gbrain ingest command is a placeholder — edit run-brain-ingest.sh" >> "$LOG"

# Archive the inbox after processing so we don't double-ingest on the next run.
# Using a timestamped archive (not delete) so we can recover if something went wrong.
ARCHIVE_DIR="$HOME/.brain-chat-inbox/archive"
mkdir -p "$ARCHIVE_DIR"
ARCHIVE="$ARCHIVE_DIR/ingested-$(date '+%Y%m%d-%H%M%S').json"
mv "$INBOX" "$ARCHIVE"
echo "[$TIMESTAMP] Archived inbox to $ARCHIVE" >> "$LOG"
echo "[$TIMESTAMP] brain-ingest complete" >> "$LOG"
