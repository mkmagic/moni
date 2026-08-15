#!/usr/bin/env bash
#
# Moni LUKS container — encryption at rest (#93 M2). Run as root ON THE BOX.
# Three deliberate phases (destructive work is never implicit):
#
#   setup-luks-container.sh create          # make + wire the container (non-destructive)
#   setup-luks-container.sh migrate         # stop services, move data in, bring up (downtime)
#   setup-luks-container.sh wipe-plaintext  # securely remove the old plaintext (after verify)
#
# The container is a LUKS2 loop-backed file holding: the Postgres cluster, the secret
# envs, swap, and the scrape browser tmp. It is unlocked manually after each reboot with
# /usr/local/sbin/moni-unlock (SSH-recoverable). The passphrase lives OFF the box.
#
set -euo pipefail

CONTAINER=/var/lib/moni-secure.img
MAPPER=moni_secure
DEV=/dev/mapper/$MAPPER
MOUNT=/mnt/secure
PGDATA=/var/lib/postgresql/16/main
SIZE=20G
SWAP=4G
HERE=$(cd "$(dirname "$0")" && pwd)

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
log(){ echo "[luks $(date -u +%H:%M:%S)] $*"; }

# Secret files to pull into the container (real path resolved; symlink left behind).
secret_paths(){
  printf '%s\n' /root/moni-secrets.env /root/moni-backup.env \
    /root/.config/rclone/rclone.conf /opt/moni/app/.env
}

cmd_create(){
  [ -f "$CONTAINER" ] && { log "$CONTAINER already exists — skipping create"; }
  if [ ! -f "$CONTAINER" ]; then
    log "allocate $SIZE container at $CONTAINER"
    fallocate -l "$SIZE" "$CONTAINER"
    chmod 600 "$CONTAINER"
    log "luksFormat (LUKS2) — you will set the passphrase now"
    cryptsetup luksFormat --type luks2 "$CONTAINER"        # interactive: owner types passphrase
  fi
  [ -e "$DEV" ] || { log "open the container — enter the passphrase"; cryptsetup open "$CONTAINER" "$MAPPER"; }
  if ! blkid "$DEV" | grep -q ext4; then
    log "mkfs.ext4 on $DEV"; mkfs.ext4 -q -L moni_secure "$DEV"
  fi
  install -d -m 755 "$MOUNT"
  mountpoint -q "$MOUNT" || mount "$DEV" "$MOUNT"
  install -d -m 755 "$MOUNT/postgresql" "$MOUNT/secrets"
  install -d -o moni -g moni -m 700 "$MOUNT/tmp"
  install -d -o postgres -g postgres -m 700 "$MOUNT/postgresql/16"

  log "write /etc/crypttab (noauto — boot never blocks; moni-unlock opens it)"
  touch /etc/crypttab
  grep -q "^$MAPPER " /etc/crypttab || echo "$MAPPER  $CONTAINER  none  luks,noauto" >> /etc/crypttab

  log "write fstab entries (noauto)"
  grep -q "^$DEV $MOUNT " /etc/fstab || echo "$DEV  $MOUNT  ext4  noauto,nofail  0 0" >> /etc/fstab
  grep -q " $PGDATA " /etc/fstab || echo "$MOUNT/postgresql/16/main  $PGDATA  none  bind,noauto,nofail  0 0" >> /etc/fstab

  log "install /usr/local/sbin/moni-unlock"
  install -m 750 "$HERE/moni-unlock.sh" /usr/local/sbin/moni-unlock

  log "systemd drop-ins: require the mount, route scrape tmp into the container"
  install -d /etc/systemd/system/moni.service.d /etc/systemd/system/postgresql@.service.d
  cat > /etc/systemd/system/moni.service.d/20-secure-store.conf <<EOF
[Unit]
RequiresMountsFor=$MOUNT $PGDATA
[Service]
Environment=TMPDIR=$MOUNT/tmp
EOF
  cat > /etc/systemd/system/postgresql@.service.d/20-secure-store.conf <<EOF
[Unit]
RequiresMountsFor=$PGDATA
EOF

  log "disable auto-start: boot stays locked until moni-unlock (SSH-recoverable design)"
  systemctl daemon-reload
  systemctl disable moni postgresql@16-main 2>/dev/null || true
  log "create done. Next: verify a fresh backup off-box, then '$0 migrate'."
}

cmd_migrate(){
  mountpoint -q "$MOUNT" || { echo "container not mounted — run '$0 create' / moni-unlock first" >&2; exit 1; }
  [ -f /root/.moni-luks-backup-verified ] || {
    echo "REFUSING: touch /root/.moni-luks-backup-verified only AFTER a fresh backup decrypts off-box." >&2
    echo "  (take deploy/backup.sh, scp it down, 'age -d -i key.txt <dump>.sql.age >/dev/null')" >&2; exit 1; }

  log "stop moni + postgres"
  systemctl stop moni 2>/dev/null || true
  systemctl stop postgresql@16-main

  log "rsync Postgres cluster into the container"
  install -d -o postgres -g postgres -m 700 "$MOUNT/postgresql/16/main"
  rsync -aHAX --delete "$PGDATA/" "$MOUNT/postgresql/16/main/"
  log "set plaintext cluster aside, make an empty bind mountpoint"
  mv "$PGDATA" "${PGDATA}.PLAINTEXT-old"
  install -d -o postgres -g postgres -m 700 "$PGDATA"

  log "relocate secret envs (real file -> container, symlink left behind)"
  for p in $(secret_paths); do
    [ -e "$p" ] || { log "  skip missing $p"; continue; }
    real=$(readlink -f "$p"); base=$(printf '%s' "$real" | tr '/' '_')
    cp -a "$real" "$MOUNT/secrets/$base"
    mv "$real" "${real}.PLAINTEXT-old"
    ln -sfn "$MOUNT/secrets/$base" "$real"
    log "  $p -> $MOUNT/secrets/$base"
  done
  chmod 711 "$MOUNT" "$MOUNT/secrets"   # let owners traverse to their 600 files

  log "move swap into the container"
  swapoff /swapfile 2>/dev/null || true
  if [ ! -f "$MOUNT/swapfile" ]; then
    fallocate -l "$SWAP" "$MOUNT/swapfile"; chmod 600 "$MOUNT/swapfile"; mkswap "$MOUNT/swapfile" >/dev/null
  fi
  sed -i '\#^/swapfile #d' /etc/fstab
  grep -q "^$MOUNT/swapfile " /etc/fstab || echo "$MOUNT/swapfile  none  swap  noauto  0 0" >> /etc/fstab

  log "bind the container cluster onto $PGDATA and bring services up"
  mount "$PGDATA"
  swapon "$MOUNT/swapfile"
  systemctl start postgresql@16-main
  systemctl start moni
  log "migrate done. Verify (verify-host.sh + a real login + a reboot drill) BEFORE wipe-plaintext."
}

cmd_wipe(){
  echo "This securely removes the plaintext originals left by migrate."
  read -r -p "Type WIPE to confirm you have verified the encrypted box (login + reboot drill): " ans
  [ "$ans" = WIPE ] || { echo "aborted"; exit 1; }
  log "shred + remove old plaintext secret envs"
  find /root /opt/moni -maxdepth 4 -name '*.PLAINTEXT-old' -type f -print -exec shred -u {} \; 2>/dev/null || true
  if [ -d "${PGDATA}.PLAINTEXT-old" ]; then
    log "remove old plaintext Postgres cluster"
    find "${PGDATA}.PLAINTEXT-old" -type f -exec shred -u {} \; 2>/dev/null || true
    rm -rf "${PGDATA}.PLAINTEXT-old"
  fi
  [ -f /swapfile ] && { log "remove old plaintext swapfile"; shred -u /swapfile 2>/dev/null || rm -f /swapfile; }
  log "fstrim (best-effort discard of freed blocks; not guaranteed on virtualized storage)"
  fstrim -av 2>/dev/null || true
  log "wipe done. Delete any pre-migration DO snapshot — it still holds plaintext."
}

case "${1:-}" in
  create) cmd_create ;;
  migrate) cmd_migrate ;;
  wipe-plaintext) cmd_wipe ;;
  *) echo "usage: $0 {create|migrate|wipe-plaintext}" >&2; exit 2 ;;
esac
