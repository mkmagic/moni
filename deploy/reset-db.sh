#!/usr/bin/env bash
#
# Moni DB RESET — DESTROYS the production database and rebuilds it empty.
# BETA ONLY. Never called by release.sh or CI. Run by hand, only when the owner has
# explicitly decided to discard all data. Requires an explicit confirmation flag.
#
#   reset-db.sh --yes-destroy-moni-data
#
# It backs up first (recoverable mistake), drops + recreates `moni`, re-runs migrations
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

TS=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p /root/moni-backups
echo "[reset] final backup before wipe: pre-reset-$TS.dump"
sudo -u postgres pg_dump -Fc moni > "/root/moni-backups/pre-reset-$TS.dump"

echo "[reset] stop app; drop + recreate database"
systemctl stop moni
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "DROP DATABASE moni WITH (FORCE);"
sudo -u postgres createdb -O postgres moni

echo "[reset] migrate from zero as superuser (recreates schema + RLS)"
sudo -u moni -H env PUPPETEER_SKIP_DOWNLOAD=true \
  DATABASE_URL_MIGRATE="postgresql://postgres:$PGSU@127.0.0.1:5432/moni" \
  bash -c "cd '$APP' && npm run db:migrate"

echo "[reset] re-assert production role passwords"
sudo -u postgres psql -v ON_ERROR_STOP=1 -d moni \
  -c "ALTER ROLE moni_owner PASSWORD '$OWNERPW';" \
  -c "ALTER ROLE moni_app   PASSWORD '$APPPW';"

systemctl start moni
echo "[reset] done — fresh empty database. Re-register the owner account at https://moni-fin.tech"
