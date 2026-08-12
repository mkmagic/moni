#!/usr/bin/env bash
#
# Moni RESTORE — load an age-encrypted backup into a Moni box's database.
# DESTRUCTIVE: drops the target `moni` database and rebuilds it from the dump.
#
#   AGE_IDENTITY=key.txt  restore.sh  <backup.sql.age>  [ssh-target]  [--yes]
#
# Runs on the machine that HOLDS THE PRIVATE AGE KEY — never the box. The box is
# a public-recipient-only endpoint (backup.sh encrypts to a public key whose
# private half is kept off-box), so it cannot read its own backups. Decryption
# happens locally here; the plaintext SQL streams over SSH straight into the
# box's Postgres and never lands on the box's disk.
#
# Input is a `pg_dumpall --globals-only` + `pg_dump --create` stream (what
# backup.sh / release.sh / reset-db.sh produce), so one file restores roles,
# database, RLS policies and rows together. Expect benign `role "..." already
# exists` errors when the roles survived on the target — psql continues past them.
#
# Pull the dump first (it lives on the box under /root/moni-backups and off-box
# on R2), e.g.:  scp root@<box>:/root/moni-backups/moni-<TS>.sql.age .
set -euo pipefail

DOMAIN=moni-fin.tech

# Positional args in any order relative to the --yes flag.
YES=0
args=()
for a in "$@"; do
  case "$a" in
    --yes) YES=1 ;;
    *) args+=("$a") ;;
  esac
done
DUMP="${args[0]:?usage: AGE_IDENTITY=key.txt restore.sh <backup.sql.age> [ssh-target] [--yes]}"
HOST="${args[1]:-root@$DOMAIN}"
: "${AGE_IDENTITY:?set AGE_IDENTITY to your PRIVATE age key file}"
[ -f "$DUMP" ]          || { echo "no such dump: $DUMP" >&2; exit 1; }
[ -f "$AGE_IDENTITY" ]  || { echo "no such key: $AGE_IDENTITY" >&2; exit 1; }

log(){ echo "[restore $(date -u +%H:%M:%S)] $*"; }

# 1. Prove the dump decrypts end-to-end BEFORE touching the box — age errors on a
#    truncated/corrupt file, so we never drop a live DB for an unrestorable source.
log "verifying $DUMP decrypts (integrity check)"
age -d -i "$AGE_IDENTITY" "$DUMP" >/dev/null
log "decrypt OK — full integrity"

# 2. Confirm — this DROPS the live database on $HOST.
if [ "$YES" != 1 ]; then
  read -r -p "This DROPS and rebuilds the moni database on $HOST. Type 'restore' to proceed: " ans
  [ "$ans" = "restore" ] || { echo "aborted."; exit 2; }
fi

# 3. Stop the app and drop the DB so the dump's CREATE DATABASE rebuilds it clean.
log "stopping app + dropping database on $HOST"
ssh "$HOST" "systemctl stop moni && sudo -u postgres psql -v ON_ERROR_STOP=1 -c 'DROP DATABASE IF EXISTS moni WITH (FORCE);'"

# 4. Decrypt locally, pipe into the box's superuser psql. ON_ERROR_STOP stays OFF
#    (psql default): 'role already exists' from the globals section is expected.
log "restoring (decrypt local -> psql on $HOST)"
age -d -i "$AGE_IDENTITY" "$DUMP" | ssh "$HOST" "sudo -u postgres psql -q -d postgres"

# 5. Verify data loaded BEFORE bringing the app up, then restart + health-check.
users=$(ssh "$HOST" "sudo -u postgres psql -tAc 'select count(*) from users' -d moni")
log "restored: users=$users — starting app"
ssh "$HOST" "systemctl start moni"
code=000
for _ in $(seq 1 12); do
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 6 "https://$DOMAIN/api/health" 2>/dev/null || echo 000)
  [ "$code" = "200" ] && break
  sleep 2
done
log "done — users=$users, health $code"
[ "$code" = "200" ] || { log "WARNING: app not healthy after restore (health $code)"; exit 1; }
