#!/bin/bash
# Add the iOS microphone usage string to the generated Tauri iOS project so
# push-to-talk works on the iPhone. Run AFTER `npm run ios:init`, on macOS.
#
# Text chat and spoken replies work without this; it's only needed for voice INPUT.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST="$ROOT/src-tauri/gen/apple/brain-avatar_iOS/Info.plist"

if [[ ! -f "$PLIST" ]]; then
  echo "Info.plist not found at:"
  echo "  $PLIST"
  echo "Run \`npm run ios:init\` first (it generates the Xcode project)." >&2
  exit 1
fi

MSG="Brain uses the microphone so you can talk to your avatar (push to talk)."

if /usr/libexec/PlistBuddy -c "Print :NSMicrophoneUsageDescription" "$PLIST" >/dev/null 2>&1; then
  /usr/libexec/PlistBuddy -c "Set :NSMicrophoneUsageDescription $MSG" "$PLIST"
  echo "✓ Updated NSMicrophoneUsageDescription in Info.plist"
else
  /usr/libexec/PlistBuddy -c "Add :NSMicrophoneUsageDescription string $MSG" "$PLIST"
  echo "✓ Added NSMicrophoneUsageDescription to Info.plist"
fi

echo "Now rebuild: npm run ios:dev"
