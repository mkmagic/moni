#!/usr/bin/env bash
# Build a self-contained, immutable release archive from an already-built tree.
set -euo pipefail

SHA="${1:?usage: package-release.sh <40-char-sha> [output.tar.gz]}"
OUT="${2:-moni-release.tar.gz}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid release SHA" >&2; exit 2; }
[ -f .next/standalone/server.js ] || { echo "run npm run build first" >&2; exit 1; }

# The standalone server contains the traced web dependencies. Moni's spawned
# tsx workers and drizzle migrations are outside Next's trace, so the archive
# also carries the locked node_modules tree plus their source/configuration.
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/app/.next/standalone/.next"
cp -a .next/standalone/. "$STAGE/app/.next/standalone/"
cp -a .next/static "$STAGE/app/.next/standalone/.next/static"
cp -a public "$STAGE/app/.next/standalone/public"
cp -a deploy drizzle node_modules scripts src "$STAGE/app/"
cp -a drizzle.config.ts next.config.ts package.json package-lock.json tsconfig.json "$STAGE/app/"
[ ! -d patches ] || cp -a patches "$STAGE/app/"
printf '%s\n' "$SHA" > "$STAGE/app/.moni-release-sha"

tar -C "$STAGE/app" -czf "$OUT" .
