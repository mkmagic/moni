#!/usr/bin/env bash
#
# Moni host verification — run as root ON THE BOX, especially after a reboot or a
# deploy. Read-only: it asserts the security posture, changes nothing. Exits non-zero
# if any check fails, so it can gate a reboot window (issue #93 M1, AC 3).
#
#   verify-host.sh [expected-ref]   optional git ref the app tree must be at
#
set -uo pipefail
# Domain is not hardcoded (SEC-21/#95) — it comes from MONI_DOMAIN in
# /root/moni-secrets.env, validated the same way release.sh validates it.
# shellcheck disable=SC1091
source /root/moni-secrets.env
: "${MONI_DOMAIN:?MONI_DOMAIN unset in /root/moni-secrets.env}"
[[ "$MONI_DOMAIN" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] && [[ "$MONI_DOMAIN" != *..* ]] \
  || { echo "MONI_DOMAIN is not a valid lowercase hostname" >&2; exit 1; }
APP=/opt/moni/app
fails=0
ok(){   printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad(){  printf '  \033[31mFAIL\033[0m %s\n' "$1"; fails=$((fails+1)); }
psqlp(){ sudo -u postgres psql -tAqc "$1"; }

echo "== production revision =="
HEAD=$(sudo -u moni git -C "$APP" rev-parse --short HEAD 2>/dev/null || echo unknown)
if [ "${1:-}" ]; then
  want=$(sudo -u moni git -C "$APP" rev-parse --short "${1}" 2>/dev/null || echo "$1")
  [ "$HEAD" = "$want" ] && ok "app at $HEAD (== $1)" || bad "app at $HEAD, expected $want ($1)"
else
  ok "app at $HEAD ($(sudo -u moni git -C "$APP" describe --tags 2>/dev/null || echo untagged))"
fi

echo "== local-only listeners (app/DB/caddy-admin must be loopback) =="
for pat in '127.0.0.1:3000' '127.0.0.1:5432' '127.0.0.1:2019'; do
  ss -tlnH | awk '{print $4}' | grep -qx "$pat" && ok "$pat loopback" || bad "$pat not bound loopback"
done
# Nothing but 80/443/22 may listen on a public address.
pub=$(ss -tlnH | awk '{print $4}' | grep -vE '^(127\.|\[::1\]|127\.0\.0\.5[34])' \
      | sed -E 's/.*:([0-9]+)$/\1/' | sort -u | grep -vE '^(80|443|22)$' || true)
[ -z "$pub" ] && ok "only 80/443/22 public" || bad "unexpected public listener port(s): $(echo $pub)"

echo "== RLS role flags + policy count =="
flags=$(psqlp "select string_agg(rolname||':'||rolsuper::int||rolbypassrls::int,',' order by rolname) from pg_roles where rolname in ('moni_app','moni_owner');")
[ "$flags" = "moni_app:00,moni_owner:00" ] && ok "moni_app/moni_owner NOSUPERUSER NOBYPASSRLS" || bad "role flags regressed: $flags"
pol=$(sudo -u postgres psql -d moni -tAqc "select count(*) from pg_policies;" | tr -d ' ')
rls=$(sudo -u postgres psql -d moni -tAqc "select count(*) from pg_class where relrowsecurity;" | tr -d ' ')
[ "${pol:-0}" -ge 33 ] && ok "$pol RLS policies (>=33)" || bad "only ${pol:-0} RLS policies (expected >=33)"
[ "${rls:-0}" -ge 32 ] && ok "$rls tables force RLS (>=32)" || bad "only ${rls:-0} RLS tables (expected >=32)"

echo "== Tier-0 off disk (swap + core dumps) =="
sm=$(systemctl show moni.service -p MemorySwapMax --value)
cl=$(systemctl show moni.service -p LimitCORE --value)
[ "$sm" = "0" ] && ok "MemorySwapMax=0" || bad "MemorySwapMax=$sm"
[ "$cl" = "0" ] && ok "LimitCORE=0" || bad "LimitCORE=$cl"
csm=$(cat /sys/fs/cgroup/system.slice/moni.service/memory.swap.max 2>/dev/null)
[ "$csm" = "0" ] && ok "live cgroup memory.swap.max=0 (workers inherit)" || bad "live cgroup memory.swap.max=$csm"
cp=$(cat /proc/sys/kernel/core_pattern)
case "$cp" in *apport*) bad "core_pattern routes to Apport: $cp";; *) ok "core_pattern discards ($cp)";; esac
[ "$(sysctl -n fs.suid_dumpable)" = "0" ] && ok "suid_dumpable=0" || bad "suid_dumpable != 0"

echo "== Blast-radius containment (#93 M3) =="
# App tree read-only to the process + no dangerous caps/transitions, so a live
# RCE can't overwrite server.js and persist. Verified against real scrapes.
[ "$(systemctl show moni.service -p ProtectSystem --value)" = "strict" ] \
  && ok "moni ProtectSystem=strict" || bad "moni ProtectSystem=$(systemctl show moni.service -p ProtectSystem --value)"
[ "$(systemctl show moni.service -p RestrictSUIDSGID --value)" = "yes" ] \
  && ok "moni RestrictSUIDSGID=yes" || bad "moni RestrictSUIDSGID not set"
[ "$(systemctl show moni.service -p LockPersonality --value)" = "yes" ] \
  && ok "moni LockPersonality=yes" || bad "moni LockPersonality not set"
[ -z "$(systemctl show moni.service -p CapabilityBoundingSet --value)" ] \
  && ok "moni CapabilityBoundingSet empty (no caps)" || bad "moni has capabilities: $(systemctl show moni.service -p CapabilityBoundingSet --value)"
# The scrape tmp must stay writable, or every sync fails silently.
systemctl show moni.service -p ReadWritePaths --value | grep -q '/mnt/secure/tmp' \
  && ok "moni ReadWritePaths includes /mnt/secure/tmp" || bad "moni ReadWritePaths missing /mnt/secure/tmp"
# Caddy terminates TLS: no core dumps, no needless caps, no priv-gain.
[ "$(systemctl show caddy.service -p LimitCORE --value)" = "0" ] \
  && ok "caddy LimitCORE=0" || bad "caddy LimitCORE=$(systemctl show caddy.service -p LimitCORE --value)"
[ "$(systemctl show caddy.service -p NoNewPrivileges --value)" = "yes" ] \
  && ok "caddy NoNewPrivileges=yes" || bad "caddy NoNewPrivileges not set"
[ "$(systemctl show caddy.service -p AmbientCapabilities --value)" = "cap_net_bind_service" ] \
  && ok "caddy ambient caps = net_bind_service only (net_admin dropped)" || bad "caddy ambient caps: $(systemctl show caddy.service -p AmbientCapabilities --value)"
[ "$(systemctl show caddy.service -p CapabilityBoundingSet --value)" = "cap_net_bind_service" ] \
  && ok "caddy bounding set = net_bind_service only" || bad "caddy bounding set: $(systemctl show caddy.service -p CapabilityBoundingSet --value)"

echo "== Encryption at rest (LUKS #93 M2) =="
# Configured if ANY artifact is present — removing one to fall back to plaintext still trips the gate.
if [ -f /var/lib/moni-secure.img ] || grep -q '^moni_secure ' /etc/crypttab 2>/dev/null \
   || grep -q ' /mnt/secure ' /etc/fstab 2>/dev/null \
   || [ -f /etc/systemd/system/moni.service.d/20-secure-store.conf ]; then
  st=$(cryptsetup status moni_secure 2>/dev/null | awk '/type:/{print $2}')
  [ "$st" = "LUKS2" ] && ok "moni_secure container open (LUKS2)" || bad "moni_secure not open — data plaintext or app down"
  [ "$(findmnt -no SOURCE /mnt/secure 2>/dev/null)" = "/dev/mapper/moni_secure" ] \
    && ok "/mnt/secure backed by encrypted mapper" || bad "/mnt/secure not backed by the encrypted mapper"
  src=$(findmnt -no SOURCE /var/lib/postgresql/16/main 2>/dev/null); src=${src%%[*}
  [ "$src" = "/dev/mapper/moni_secure" ] && ok "Postgres data on encrypted mapper" \
    || bad "Postgres data source is '${src:-<unmounted>}', not the encrypted mapper"
  # Every secret must resolve onto the encrypted mount — catches a deploy that rewrote a plaintext .env.
  secok=1
  for s in /root/moni-secrets.env /root/moni-backup.env /root/.config/rclone/rclone.conf /opt/moni/app/.env; do
    case "$(readlink -f "$s" 2>/dev/null)" in
      /mnt/secure/*) : ;;
      *) bad "secret NOT on encrypted store: $s -> $(readlink -f "$s" 2>/dev/null)"; secok=0 ;;
    esac
  done
  [ "$secok" = 1 ] && ok "all secret envs resolve onto the encrypted store"
  swapon --show=NAME --noheadings 2>/dev/null | grep -qx /swapfile \
    && bad "plaintext /swapfile is active" || ok "no plaintext swap active"
  left=$(find /root /opt/moni /var/lib/postgresql -maxdepth 4 -name '*.PLAINTEXT-old' 2>/dev/null | head -1)
  [ -z "$left" ] && ok "no *.PLAINTEXT-old plaintext leftovers" || bad "plaintext leftover: $left (run wipe-plaintext)"
  [ "$(systemctl show moni.service -p Environment --value 2>/dev/null | tr ' ' '\n' | grep '^TMPDIR=')" = "TMPDIR=/mnt/secure/tmp" ] \
    && ok "moni TMPDIR routed into the container" || bad "moni TMPDIR not /mnt/secure/tmp (scrape state may hit plaintext)"
else
  echo "  -- LUKS container not configured (M2 pending) — skipping"
fi

echo "== Chrome sandbox preserved =="
[ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null)" = "0" ] \
  && ok "unprivileged userns allowed (sandbox usable)" || bad "userns restricted — Chrome sandbox may break"
# The sandbox is disabled only by an explicit --no-sandbox in the app env; the source
# tree isn't shipped in a standalone build, so assert against the live .env.
if grep -q -- '--no-sandbox' "$APP/.env" 2>/dev/null; then
  bad "--no-sandbox set in app .env"
else
  ok "no --no-sandbox in app .env"
fi

echo "== off-box backups armed =="
[ "$(systemctl is-active moni-backup.timer)" = "active" ] && ok "moni-backup.timer active" || bad "moni-backup.timer not active"
res=$(systemctl show moni-backup.service -p ExecMainStatus --value 2>/dev/null)
[ "${res:-0}" = "0" ] && ok "last backup run exit=$res" || bad "last backup run exit=$res"

echo "== DNS/TLS + non-credential health =="
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 "https://$MONI_DOMAIN/api/health" 2>/dev/null || echo 000)
[ "$code" = "200" ] && ok "https://$MONI_DOMAIN/api/health = 200 (TLS + Postgres + schema)" || bad "/api/health = $code"

echo
if [ "$fails" -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "$fails CHECK(S) FAILED"; fi
exit $([ "$fails" -eq 0 ] && echo 0 || echo 1)
