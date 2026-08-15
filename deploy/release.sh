#!/usr/bin/env bash
# Receive and atomically deploy a CI-built Moni artifact. Forward-only and
# non-destructive: the only database operation is the normal Drizzle migrate.
set -euo pipefail

ROOT=/opt/moni
APP="$ROOT/app"
RELEASES="$ROOT/releases"
INCOMING="$ROOT/incoming"
SHARED="$ROOT/shared"

read -r COMMAND SHA EXPECTED_DIGEST EXTRA <<< "${SSH_ORIGINAL_COMMAND:-${*:-}}"
[ "$COMMAND" = deploy ] && [ -z "${EXTRA:-}" ] || {
  echo "usage: deploy <40-char-sha> <sha256>" >&2
  exit 2
}
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid release SHA" >&2; exit 2; }
[[ "$EXPECTED_DIGEST" =~ ^[0-9a-f]{64}$ ]] || { echo "invalid artifact digest" >&2; exit 2; }

# shellcheck disable=SC1091
source /root/moni-secrets.env
: "${MIGRATE_STEADY:?MIGRATE_STEADY unset in /root/moni-secrets.env}"
: "${MONI_DOMAIN:?MONI_DOMAIN unset in /root/moni-secrets.env}"
[[ "$MONI_DOMAIN" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] \
  && [[ "$MONI_DOMAIN" != *..* ]] \
  || { echo "MONI_DOMAIN is not a valid lowercase hostname" >&2; exit 1; }

[ -f /root/moni-backup.env ] || { echo "missing /root/moni-backup.env" >&2; exit 1; }
# shellcheck disable=SC1091
source /root/moni-backup.env
: "${AGE_RECIPIENT:?AGE_RECIPIENT unset in /root/moni-backup.env}"

log(){ echo "[release $(date -u +%H:%M:%S)] $*"; }
asmoni(){ sudo -u moni -H "$@"; }
health(){ curl -sS -o /dev/null -w '%{http_code}' --max-time 6 "https://$MONI_DOMAIN/api/health" 2>/dev/null || true; }
wait_for_health(){
  local code=000
  for _ in $(seq 1 12); do
    code=$(health)
    [ "$code" = 200 ] && { printf '%s' "$code"; return 0; }
    sleep 2
  done
  printf '%s' "$code"
  return 1
}
switch_app(){
  ln -sfn "$1" "$ROOT/.app-next"
  mv -Tf "$ROOT/.app-next" "$APP"
}
rollback_cutover(){
  log "rolling app and service back to $PREVIOUS"
  switch_app "$PREVIOUS" || return 1
  install -m 644 "$UNIT_BACKUP" /etc/systemd/system/moni.service || return 1
  systemctl daemon-reload || return 1
  systemctl restart moni || return 1
  local rollback_code
  if ! rollback_code=$(wait_for_health); then
    log "rollback health $rollback_code"
    return 1
  fi
  log "rollback health $rollback_code"
}

# Tier-0 guard (#93 M1): decrypted keys, passwords, and fields must
# never reach swap or a core dump. Check the effective live unit before
# accepting an artifact; a hardened base unit or drop-in may provide it.
SWAPMAX=$(systemctl show moni.service -p MemorySwapMax --value)
CORELIM=$(systemctl show moni.service -p LimitCORE --value)
[ "$SWAPMAX" = 0 ] && [ "$CORELIM" = 0 ] || {
  echo "REFUSING TO DEPLOY: moni.service MemorySwapMax=$SWAPMAX LimitCORE=$CORELIM (both must be 0)" >&2
  exit 1
}

mkdir -p "$RELEASES" "$INCOMING" "$SHARED" /root/moni-backups
ARCHIVE="$INCOMING/$SHA.tar.gz"
STAGE="$RELEASES/.stage-$SHA-$$"
FINAL="$RELEASES/$SHA"
UNIT_BACKUP="$ROOT/.moni.service-$SHA-$$"
CUTOVER_ACTIVE=0
cleanup(){
  local rc=$?
  trap - EXIT
  set +e
  rm -f "$ARCHIVE" "$ROOT/.app-next"
  [ ! -d "${STAGE:-}" ] || rm -rf "$STAGE"
  if [ "$rc" -ne 0 ] && [ "$CUTOVER_ACTIVE" = 1 ]; then
    if ! rollback_cutover; then
      log "CRITICAL: automatic rollback failed; service backup preserved at $UNIT_BACKUP"
      exit "$rc"
    fi
  fi
  rm -f "$UNIT_BACKUP"
  exit "$rc"
}
trap cleanup EXIT
[ ! -e "$FINAL" ] || { echo "release $SHA already exists" >&2; exit 1; }

log "receive artifact $SHA"
cat > "$ARCHIVE"
ACTUAL_DIGEST=$(sha256sum "$ARCHIVE" | cut -d' ' -f1)
[ "$ACTUAL_DIGEST" = "$EXPECTED_DIGEST" ] || { echo "artifact digest mismatch" >&2; exit 1; }
tar -tzf "$ARCHIVE" | awk '
  /^\// || /(^|\/)\.\.($|\/)/ { bad=1 }
  END { exit bad }
' || { echo "unsafe artifact path" >&2; exit 1; }

mkdir "$STAGE"
chown moni:moni "$STAGE"
asmoni tar -xzf "$ARCHIVE" -C "$STAGE"
[ "$(cat "$STAGE/.moni-release-sha")" = "$SHA" ] || { echo "artifact SHA mismatch" >&2; exit 1; }
[ -f "$STAGE/.next/standalone/server.js" ] || { echo "artifact has no server" >&2; exit 1; }

if [ ! -f "$SHARED/.env" ]; then
  [ -f "$APP/.env" ] || { echo "current app has no .env to migrate" >&2; exit 1; }
  install -o moni -g moni -m 600 "$APP/.env" "$SHARED/.env"
fi
ln -s "$SHARED/.env" "$STAGE/.env"

log "reconcile Chrome with artifact's Puppeteer version"
EXP=$(asmoni bash -c "cd '$STAGE' && node -p 'require(\"puppeteer\").executablePath()'")
VER=$(printf '%s' "$EXP" | sed -E 's#.*/chrome/linux-([0-9.]+)/.*#\1#')
if ! sudo -u moni test -x "$EXP"; then
  log "Chrome $VER missing — downloading"
  asmoni mkdir -p /home/moni/.cache/puppeteer/chrome
  asmoni bash -c "cd /home/moni/.cache/puppeteer/chrome && rm -rf 'linux-$VER' \
    && curl -fsSL -o c.zip 'https://storage.googleapis.com/chrome-for-testing-public/$VER/linux64/chrome-linux64.zip' \
    && mkdir 'linux-$VER' && unzip -q c.zip -d 'linux-$VER/' \
    && chmod -R +x 'linux-$VER/chrome-linux64/' && rm c.zip"
fi
if grep -q '^MONI_CHROME_PATH=' "$SHARED/.env"; then
  sudo -u moni sed -i "s#^MONI_CHROME_PATH=.*#MONI_CHROME_PATH=$EXP#" "$SHARED/.env"
else
  printf 'MONI_CHROME_PATH=%s\n' "$EXP" | sudo -u moni tee -a "$SHARED/.env" >/dev/null
fi

log "pre-deploy encrypted backup"
TS=$(date -u +%Y%m%dT%H%M%SZ)
OUT="/root/moni-backups/predeploy-$TS.sql.age"
{ sudo -u postgres pg_dumpall --globals-only
  sudo -u postgres pg_dump --create moni
} | age -r "$AGE_RECIPIENT" > "$OUT"
log "backup $(basename "$OUT") ($(du -h "$OUT" | cut -f1))"
ls -1t /root/moni-backups/predeploy-*.sql.age 2>/dev/null | tail -n +15 | xargs -r rm -f

log "migrate $SHA (moni_owner, forward-only)"
asmoni env DATABASE_URL_MIGRATE="$MIGRATE_STEADY" bash -c "cd '$STAGE' && npm run db:migrate"

mv "$STAGE" "$FINAL"
PREVIOUS=$(readlink -f "$APP")
cp -a /etc/systemd/system/moni.service "$UNIT_BACKUP"
CUTOVER_ACTIVE=1
if [ ! -L "$APP" ]; then
  PREVIOUS="$RELEASES/legacy-$TS"
  mv "$APP" "$PREVIOUS"
  ln -s "$FINAL" "$APP"
else
  switch_app "$FINAL"
fi

install -m 644 "$FINAL/deploy/moni.service" /etc/systemd/system/moni.service
systemctl daemon-reload
systemctl restart moni
if code=$(wait_for_health); then
  install -m 755 "$FINAL/deploy/release.sh" "$ROOT/release.sh.next"
  mv -f "$ROOT/release.sh.next" "$ROOT/release.sh"
  CUTOVER_ACTIVE=0
  log "done — $SHA, health $code"
  exit 0
fi

log "health $code"
exit 1
