#!/bin/bash
# Install-path smoke for dsh-task-notify.
# Builds a fresh tarball, installs it into a throwaway consumer project,
# and runs scripts/install-smoke.mjs against the installed module.
# Exits 0 iff the full path (pack -> install -> import -> apply -> channel
# dispatch) works. No side effects on the host project (uses a temp dir,
# npm with a project-local cache).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
TMP="$(mktemp -d -t dsh-smoke-XXXXXX)"
LOCAL_CACHE="$ROOT/.npm-cache"
mkdir -p "$LOCAL_CACHE"
trap 'rm -rf "$TMP"' EXIT

cd "$ROOT"
npm pack --cache "$LOCAL_CACHE" --pack-destination "$TMP" >/dev/null
TGZ="$(ls -t "$TMP"/dsh-task-notify-*.tgz | head -1)"

mkdir -p "$TMP/app"
cat > "$TMP/app/package.json" <<JSON
{
  "name": "dsh-install-smoke",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": { "dsh-task-notify": "file:$TGZ" }
}
JSON

cd "$TMP/app"
npm install --no-save --no-package-lock --cache "$LOCAL_CACHE" >/dev/null
cp "$HERE/install-smoke.mjs" smoke.mjs
node smoke.mjs
