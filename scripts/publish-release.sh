#!/bin/bash
# One-command release publisher for Brain Avatar auto-updates.
#
#   scripts/publish-release.sh <new-version>      e.g.  scripts/publish-release.sh 0.1.1
#
# Bumps the version, builds the signed app + updater artifacts, creates the GitHub
# Release, and uploads latest.json so the endpoint the app polls
# (https://github.com/Moil-Code/brain-avatar/releases/latest/download/latest.json)
# serves the new version. Every Brain Avatar (Mac Mini + MacBook) auto-installs it
# on next launch.
#
# Prereqs (already present on the Mac Mini): the updater signing key at
# ~/.tauri/brain-avatar-updater.key, the "Brain Avatar Code Signing" identity in the
# keychain, gh authed with push access to Moil-Code/brain-avatar.
set -euo pipefail

VER="${1:?usage: scripts/publish-release.sh <version>   e.g. 0.1.1}"
REPO="Moil-Code/brain-avatar"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

KEY="$HOME/.tauri/brain-avatar-updater.key"
[[ -f "$KEY" ]] || { echo "Missing updater key at $KEY" >&2; exit 1; }
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "⚠️  Working tree has uncommitted changes — they'll be baked into this build." >&2
  read -r -p "Continue anyway? [y/N] " ok; [[ "$ok" == "y" ]] || exit 1
fi

echo "==> Bumping version to $VER (tauri.conf.json + Cargo.toml + package.json)"
python3 - "$VER" <<'PY'
import json, sys
v = sys.argv[1]
for p in ("src-tauri/tauri.conf.json", "package.json"):
    d = json.load(open(p)); d["version"] = v
    json.dump(d, open(p, "w"), indent=2); open(p, "a").write("\n")
PY
sed -i '' "s/^version = \".*\"/version = \"$VER\"/" src-tauri/Cargo.toml

echo "==> Building signed app + updater artifacts"
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
export PATH="$HOME/.cargo/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
npm run tauri build

APP="src-tauri/target/release/bundle/macos/Brain Avatar.app.tar.gz"
[[ -f "$APP" && -f "$APP.sig" ]] || { echo "Build did not produce updater artifacts" >&2; exit 1; }
cp "$APP" "/tmp/Brain.Avatar.app.tar.gz"
SIG="$(cat "$APP.sig")"
PUBDATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

cat > /tmp/latest.json <<EOF
{
  "version": "$VER",
  "notes": "Update $VER",
  "pub_date": "$PUBDATE",
  "platforms": {
    "darwin-aarch64": {
      "signature": "$SIG",
      "url": "https://github.com/$REPO/releases/download/v$VER/Brain.Avatar.app.tar.gz"
    }
  }
}
EOF

echo "==> Publishing GitHub Release v$VER"
git add src-tauri/tauri.conf.json src-tauri/Cargo.toml package.json
git commit -q -m "chore: release v$VER" || true
timeout 30 git push origin main || echo "(push failed/skipped — release still publishes; push when ready)"
gh release create "v$VER" --repo "$REPO" --title "Brain Avatar v$VER" --notes "Update $VER" "/tmp/Brain.Avatar.app.tar.gz"
gh release upload "v$VER" /tmp/latest.json --repo "$REPO"

echo "✅ Published v$VER. Every Brain Avatar auto-updates on next launch."
