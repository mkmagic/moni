#!/usr/bin/env bash
#
# Moni unlock — run as root ON THE BOX after every reboot (installed as
# /usr/local/sbin/moni-unlock). Opens the LUKS container that holds Postgres data,
# the secret envs, swap, and the scrape browser tmp, then brings Postgres + Moni up.
#
# The passphrase is typed at cryptsetup's own prompt on this terminal — it never
# touches a shell variable, a file, or the journal. Enter it over SSH (this command)
# or at the DO web console. The passphrase lives OFF the box (owner's password
# manager); losing it means the data is unrecoverable except from an off-box backup.
#
set -euo pipefail

CONTAINER=/var/lib/moni-secure.img
MAPPER=moni_secure
MOUNT=/mnt/secure
PGDATA=/var/lib/postgresql/16/main

[ "$(id -u)" = 0 ] || { echo "moni-unlock: run as root" >&2; exit 1; }
[ -f "$CONTAINER" ] || { echo "moni-unlock: $CONTAINER missing (run setup-luks-container.sh create first)" >&2; exit 1; }

if [ -e "/dev/mapper/$MAPPER" ]; then
  echo "moni-unlock: container already open"
else
  cryptsetup open "$CONTAINER" "$MAPPER"      # prompts for the passphrase on this tty
fi

mountpoint -q "$MOUNT"  || mount "$MOUNT"      # fstab: /dev/mapper/moni_secure -> /mnt/secure (noauto)
mountpoint -q "$PGDATA" || mount "$PGDATA"     # fstab: bind /mnt/secure/postgresql/16/main (noauto)
swapon "$MOUNT/swapfile" 2>/dev/null || true   # no-op if already on

# Secret envs are symlinked into the container, so they resolve only now.
systemctl start postgresql@16-main
systemctl start moni

# Health wait (domain comes from the now-readable secrets file, never hardcoded).
# shellcheck disable=SC1091
MONI_DOMAIN=$(. /root/moni-secrets.env 2>/dev/null && printf '%s' "${MONI_DOMAIN:-}")
for _ in $(seq 1 12); do
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 6 "https://$MONI_DOMAIN/api/health" 2>/dev/null || echo 000)
  [ "$code" = "200" ] && { echo "moni-unlock: Moni up (health 200)"; exit 0; }
  sleep 2
done
echo "moni-unlock: unlocked + services started, but health != 200 — check 'journalctl -u moni -n50'" >&2
exit 1
