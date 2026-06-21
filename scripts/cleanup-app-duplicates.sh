#!/bin/bash
# Remove duplicate "Brain Avatar.app" copies from Launchpad / Spotlight.
#
# Every `tauri build` drops a fresh Brain Avatar.app under
# src-tauri/target/release/bundle/macos/, and each release DMG gets mounted —
# macOS registers all of them with Launch Services, so Launchpad shows ghost
# duplicates alongside the real install. This keeps ONLY the installed
# /Applications/Brain Avatar.app and clears the rest.
#
# Safe + idempotent: only deletes this repo's disposable build artifact (it
# regenerates on the next build); everything else is just LS unregister + DMG
# eject. Run standalone any time, or `npm run cleanup:apps`.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LS="/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister"
KEEP="/Applications/Brain Avatar.app"

echo "==> De-duplicating Brain Avatar.app (keeping $KEEP)"

# 1. Delete this repo's build artifact (regenerates on next `tauri build`).
ARTIFACT="$ROOT/src-tauri/target/release/bundle/macos/Brain Avatar.app"
if [[ -d "$ARTIFACT" ]]; then
  rm -rf "$ARTIFACT" && echo "   removed build artifact: $ARTIFACT"
fi

# 2. Eject any mounted installer DMG that carries a Brain Avatar.app.
for vol in /Volumes/dmg.*; do
  [[ -e "$vol/Brain Avatar.app" ]] || continue
  hdiutil detach "$vol" -quiet && echo "   ejected installer DMG: $vol"
done

# 3. Unregister every Brain Avatar.app Launch Services knows about except the keeper.
#    (pipe-into-while, not mapfile — macOS ships bash 3.2 which lacks mapfile)
"$LS" -dump 2>/dev/null \
  | grep -iE 'path:.*Brain Avatar\.app' \
  | sed -E 's/^[[:space:]]*path:[[:space:]]*//; s/ \(0x[0-9a-f]+\)$//' \
  | sort -u \
  | while IFS= read -r p; do
      [[ -z "$p" || "$p" == "$KEEP" ]] && continue
      "$LS" -u "$p" 2>/dev/null && echo "   unregistered: $p"
    done

# 4. Ensure the keeper is registered, then refresh Launchpad.
[[ -d "$KEEP" ]] && "$LS" -f "$KEEP"
killall Dock 2>/dev/null || true

echo "==> Done. Registered Brain Avatar bundles now:"
"$LS" -dump 2>/dev/null | grep -iE 'path:.*Brain Avatar\.app' \
  | sed -E 's/^[[:space:]]*/   /' | sort -u
