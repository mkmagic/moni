#!/usr/bin/env bash
#
# Moni off-box backup. Dumps roles + schema + data as one restore-complete stream,
# encrypts it with `age` to a PUBLIC recipient (so the box CANNOT read its own backups),
# and uploads it off-site. Intended to run nightly from a systemd timer.
#
# Arm by creating /root/moni-backup.env (root, 600):
#   AGE_RECIPIENT=age1xxxxxxxx…        # public key ONLY; the private key lives OFF the box
#   RCLONE_REMOTE=r2:moni-backups      # an rclone remote (e.g. Cloudflare R2); empty = local-only
#
# Restore (on a scratch DB, from a machine that HAS the private key):
#   age -d -i key.txt moni-YYYY…​.sql.age | psql "postgresql://postgres@127.0.0.1/postgres"
# then verify rows, roles, RLS, and that encrypted columns still decrypt (AAD survived).
set -euo pipefail
# shellcheck disable=SC1091
source /root/moni-backup.env

TS=$(date -u +%Y%m%dT%H%M%SZ)
WORK=/root/moni-backups
mkdir -p "$WORK"
OUT="$WORK/moni-$TS.sql.age"

# globals (roles + their SCRAM passwords) THEN a --create dump (CREATE DATABASE + data),
# so the single stream restores roles, database, RLS policies and rows together.
{ sudo -u postgres pg_dumpall --globals-only
  sudo -u postgres pg_dump --create moni
} | age -r "$AGE_RECIPIENT" > "$OUT"
echo "[backup] $OUT ($(du -h "$OUT" | cut -f1))"

if [ -n "${RCLONE_REMOTE:-}" ]; then
  rclone copy "$OUT" "$RCLONE_REMOTE/" && echo "[backup] uploaded to $RCLONE_REMOTE"
fi

ls -1t "$WORK"/moni-*.sql.age 2>/dev/null | tail -n +15 | xargs -r rm -f   # keep 14 encrypted copies
