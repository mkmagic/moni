#!/usr/bin/env bash
#
# Moni release — deploy a git ref to the running box. Forward-only, non-destructive.
#
#   release.sh [ref]     ref defaults to origin/dev; pass a tag (e.g. v1.2.3) for real releases.
#
# Invoked interactively (arg) or by CI over SSH with a forced command, where the ref
# arrives in $SSH_ORIGINAL_COMMAND (authorized_keys: command=".../release.sh").
#
# DATA SAFETY: takes a pre-deploy pg_dump, runs ONLY additive drizzle migrations, and
# NEVER drops or recreates the database. Rewriting the DB is a separate, explicit action
# (reset-db.sh). Keep it that way.
set -euo pipefail

REF="${1:-${SSH_ORIGINAL_COMMAND:-}}"
REF="${REF##* }"                 # forced command hands us the whole line; keep the last token
REF="${REF:-origin/dev}"

APP=/opt/moni/app
DOMAIN=moni-fin.tech
# shellcheck disable=SC1091
source /root/moni-secrets.env    # provides MIGRATE_STEADY (moni_owner DDL URL)

log(){ echo "[release $(date -u +%H:%M:%S)] $*"; }
asmoni(){ sudo -u moni -H "$@"; }

log "pre-deploy backup"
mkdir -p /root/moni-backups
TS=$(date -u +%Y%m%dT%H%M%SZ)
sudo -u postgres pg_dump -Fc moni          > "/root/moni-backups/moni-$TS.dump"
sudo -u postgres pg_dumpall --globals-only > "/root/moni-backups/globals-$TS.sql"
log "backup moni-$TS.dump ($(du -h "/root/moni-backups/moni-$TS.dump" | cut -f1))"
ls -1t /root/moni-backups/moni-*.dump 2>/dev/null | tail -n +15 | xargs -r rm -f  # keep 14

log "fetch $REF"
asmoni git -C "$APP" fetch origin --tags --prune --quiet
if asmoni git -C "$APP" show-ref --verify --quiet "refs/tags/$REF"; then
  asmoni git -C "$APP" checkout -f --detach "$REF" --quiet          # release tag
else
  asmoni git -C "$APP" checkout -f "$REF" --quiet
  asmoni git -C "$APP" reset --hard "origin/$REF" --quiet           # branch
fi
log "at $(asmoni git -C "$APP" rev-parse --short HEAD)"

log "npm ci (Chrome managed separately — skip puppeteer download)"
asmoni env PUPPETEER_SKIP_DOWNLOAD=true PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
  bash -c "cd '$APP' && npm ci --no-audit --no-fund"

log "reconcile Chrome with puppeteer's expected build"
EXP=$(asmoni bash -c "cd '$APP' && node -p 'require(\"puppeteer\").executablePath()'")
VER=$(printf '%s' "$EXP" | sed -E 's#.*/chrome/linux-([0-9.]+)/.*#\1#')
if ! sudo -u moni test -x "$EXP"; then
  log "Chrome $VER missing — downloading"
  asmoni bash -c "cd ~/.cache/puppeteer/chrome && rm -rf 'linux-$VER' \
    && curl -sSL -o c.zip 'https://storage.googleapis.com/chrome-for-testing-public/$VER/linux64/chrome-linux64.zip' \
    && mkdir -p 'linux-$VER' && unzip -q c.zip -d 'linux-$VER/' \
    && chmod -R +x 'linux-$VER/chrome-linux64/' && rm c.zip"
fi
grep -q "^MONI_CHROME_PATH=$EXP$" "$APP/.env" \
  || sudo -u moni sed -i "s#^MONI_CHROME_PATH=.*#MONI_CHROME_PATH=$EXP#" "$APP/.env"

log "build"
asmoni bash -c "cd '$APP' && npm run build"

log "migrate (moni_owner, forward-only)"
asmoni env DATABASE_URL_MIGRATE="$MIGRATE_STEADY" bash -c "cd '$APP' && npm run db:migrate"

log "restart"
systemctl restart moni
code=000
for _ in $(seq 1 12); do
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 6 "https://$DOMAIN/" 2>/dev/null || echo 000)
  { [ "$code" = "307" ] || [ "$code" = "200" ]; } && break
  sleep 2
done
log "done — $(asmoni git -C "$APP" rev-parse --short HEAD), https $code"
{ [ "$code" = "307" ] || [ "$code" = "200" ]; } || { log "WARNING: app not healthy (https $code)"; exit 1; }
