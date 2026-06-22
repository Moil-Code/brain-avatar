#!/bin/bash
# Cut a release THROUGH CI: bump the version, commit, tag, and push. The Release
# workflow (.github/workflows/release.yml) then builds, signs, and publishes on a
# GitHub Apple-Silicon runner — no local build needed. Every Brain Avatar
# auto-installs it on next launch.
#
#   scripts/tag-release.sh              auto-bump patch (0.1.32 -> 0.1.33)
#   scripts/tag-release.sh minor|major  bump that component
#   scripts/tag-release.sh 0.2.0        explicit version
#
# This is the CI counterpart of publish-release.sh (which builds locally). Use this
# once the signing secrets are in the repo (see release.yml header); use
# publish-release.sh when you need to build/ship offline from the Mac Mini.
#
# One-time secrets (Settings → Secrets and variables → Actions):
#   TAURI_SIGNING_PRIVATE_KEY           cat ~/.tauri/brain-avatar-updater.key
#   TAURI_SIGNING_PRIVATE_KEY_PASSWORD  "" (empty for our key)
#   APPLE_CERTIFICATE                   base64 of the "Brain Avatar Code Signing" .p12
#   APPLE_CERTIFICATE_PASSWORD          the .p12 export password
#   KEYCHAIN_PASSWORD                   any random string
set -euo pipefail

REPO="Moil-Code/brain-avatar"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Release exactly what's on main: require a clean, up-to-date main checkout.
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || { echo "Switch to main first (currently on $BRANCH)." >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "Commit or stash your changes first." >&2; exit 1; }
git pull --ff-only origin main

CUR="$(python3 -c "import json;print(json.load(open('src-tauri/tauri.conf.json'))['version'])")"
case "${1:-patch}" in
  major) VER="$(python3 -c "v='$CUR'.split('.');print(f'{int(v[0])+1}.0.0')")" ;;
  minor) VER="$(python3 -c "v='$CUR'.split('.');print(f'{v[0]}.{int(v[1])+1}.0')")" ;;
  patch) VER="$(python3 -c "v='$CUR'.split('.');print(f'{v[0]}.{v[1]}.{int(v[2])+1}')")" ;;
  *)     VER="$1" ;;
esac
echo "==> Tagging $CUR → v$VER (CI builds + publishes)"
if git rev-parse "v$VER" >/dev/null 2>&1; then
  echo "Tag v$VER already exists — pass a higher explicit version." >&2; exit 1
fi

echo "==> Bumping version (tauri.conf.json + package.json + Cargo.toml)"
python3 - "$VER" <<'PY'
import json, sys
v = sys.argv[1]
for p in ("src-tauri/tauri.conf.json", "package.json"):
    d = json.load(open(p)); d["version"] = v
    json.dump(d, open(p, "w"), indent=2); open(p, "a").write("\n")
PY
sed -i '' "s/^version = \".*\"/version = \"$VER\"/" src-tauri/Cargo.toml
# Keep Cargo.lock's package version in sync (offline — deps are already locked).
( cd src-tauri && cargo update --offline -p brain-avatar >/dev/null 2>&1 ) \
  || echo "(Cargo.lock will be reconciled by the CI build)"

git add src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock package.json
git commit -m "chore: release v$VER"
git tag "v$VER"
git push origin main
git push origin "v$VER"

echo "✅ Pushed v$VER. Watch it build + publish:"
echo "   https://github.com/$REPO/actions"
