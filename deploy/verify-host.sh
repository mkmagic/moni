#!/usr/bin/env bash
#
# Moni host verification — run as root ON THE BOX, especially after a reboot or a
# deploy. Read-only: it asserts the security posture, changes nothing. Exits non-zero
# if any check fails, so it can gate a reboot window (issue #93 M1, AC 3).
#
#   verify-host.sh [expected-ref]   optional git ref the app tree must be at
#
set -uo pipefail
DOMAIN=moni-fin.tech
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
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 "https://$DOMAIN/api/health" 2>/dev/null || echo 000)
[ "$code" = "200" ] && ok "https://$DOMAIN/api/health = 200 (TLS + Postgres + schema)" || bad "/api/health = $code"

echo
if [ "$fails" -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "$fails CHECK(S) FAILED"; fi
exit $([ "$fails" -eq 0 ] && echo 0 || echo 1)
