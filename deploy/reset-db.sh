#!/usr/bin/env bash
#
# Moni DB RESET — DESTROYS the production database and rebuilds it empty.
# BETA ONLY. Never called by release.sh or CI. Run by hand, only when the owner has
# explicitly decided to discard all data. Requires an explicit confirmation flag.
#
#   reset-db.sh --yes-destroy-moni-data
#
# It backs up first (age-encrypted — recover needs the off-box key), drops + recreates `moni`, re-runs migrations
# from zero as the superuser (0001 recreates schema + RLS; the cluster-level roles survive
# the drop, so their passwords are preserved — re-asserted at the end to be safe).
set -euo pipefail

[ "${1:-}" = "--yes-destroy-moni-data" ] || {
  echo "Refusing: this DESTROYS all data in the moni database." >&2
  echo "Re-run with:  reset-db.sh --yes-destroy-moni-data" >&2
  exit 2
}

APP=/opt/moni/app
# shellcheck disable=SC1091
source /root/moni-secrets.env    # PGSU, OWNERPW, APPPW
[ -f /root/moni-backup.env ] || { echo "missing /root/moni-backup.env — arm off-box backups first (deployment skill)"; exit 1; }
# shellcheck disable=SC1091
source /root/moni-backup.env     # AGE_RECIPIENT (PUBLIC key) — the pre-reset dump is encrypted
: "${AGE_RECIPIENT:?AGE_RECIPIENT unset in /root/moni-backup.env}"

# Percent-encode for safe placement in a URI userinfo field: PGSU can contain
# characters (@ : / ? #) that would otherwise corrupt the connection string.
urlenc(){ local s=$1 o= c i; for ((i=0; i<${#s}; i++)); do c=${s:i:1}
  case $c in [a-zA-Z0-9.~_-]) ;; *) printf -v c '%%%02X' "'$c";; esac; o+=$c
  done; printf '%s' "$o"; }

TS=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p /root/moni-backups
echo "[reset] final backup before wipe: pre-reset-$TS.sql.age (age-encrypted, like backup.sh)"
{ sudo -u postgres pg_dumpall --globals-only
  sudo -u postgres pg_dump --create moni
} | age -r "$AGE_RECIPIENT" > "/root/moni-backups/pre-reset-$TS.sql.age"

echo "[reset] stop app; drop + recreate database"
systemctl stop moni
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "DROP DATABASE moni WITH (FORCE);"
sudo -u postgres createdb -O postgres moni

echo "[reset] migrate from zero as superuser (recreates schema + RLS)"
sudo -u moni -H env PUPPETEER_SKIP_DOWNLOAD=true \
  DATABASE_URL_MIGRATE="postgresql://postgres:$(urlenc "$PGSU")@127.0.0.1:5432/moni" \
  bash -c "cd '$APP' && npm run db:migrate"

# Bind the passwords as psql variables and quote them for SQL with :'var', which
# escapes the value as a proper string literal — so a password containing a '
# can't break out and leave the roles half-reset after the DROP above. (The
# value is still on psql's argv, same as the migrate line; on a single-owner box
# that local-process exposure is out of scope — the injection footgun is not.)
echo "[reset] re-assert production role passwords"
sudo -u postgres psql -v ON_ERROR_STOP=1 -d moni \
  -v ownerpw="$OWNERPW" -v apppw="$APPPW" \
  -c "ALTER ROLE moni_owner PASSWORD :'ownerpw';" \
  -c "ALTER ROLE moni_app   PASSWORD :'apppw';"

systemctl start moni
echo "[reset] done — fresh empty database. Re-register the owner account at https://moni-fin.tech"
