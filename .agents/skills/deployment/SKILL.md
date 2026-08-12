---
name: deployment
description: Deploying a Moni version and provisioning/operating the production host (self-hosted VPS). Use when releasing a version, setting up a new droplet/host, or debugging a deployment. Covers topology, host setup, the TLS/DNS-01 gotcha, the release flow, and what is verified vs not.
---

# Deploying Moni

How Moni runs in production and how to release to it. Pairs with the `israeli-scraper`
skill (Chrome/Puppeteer specifics) and `db-schema` (migrations).

## Current production (2026-08-11)

- **Host:** DigitalOcean, region **FRA1**, 2 vCPU / 4 GB / 80 GB, **x86_64**, Ubuntu 24.04.
- **Domain:** `moni-fin.tech` — registrar get.tech, **DNS on Cloudflare (grey-cloud / DNS-only)**.
- **Topology:** **bare-host, no Docker.** Next via systemd `moni.service` (`next start -H 127.0.0.1`,
  loopback only); Postgres 16 co-located (loopback); Caddy terminates TLS. Chrome-for-Testing
  managed by hand.
- **App runs as user `moni`** (`/opt/moni/app`). Secrets: `/root/moni-secrets.env` (root, 600) holds
  role passwords + signup token + `MIGRATE_STEADY`; app runtime env is `/opt/moni/app/.env`
  (moni, 600). The `moni_owner` migrate credential is injected **only at migrate time**, never in
  the app's env.

## Provisioning a new host (x86_64 Ubuntu 24.04)

- **x86_64 only** — Chrome-for-Testing has no `linux-arm64` build (#48). Shared vCPU is fine; size
  for **RAM** (~1.3–1.6 GB peak per scrape, #54), not disk (DB is hundreds of MB). On 4 GB, **add
  swap** as OOM insurance for the rest of the box — but the app itself must be barred from it (next
  bullet). Two concurrent scrapes do not fit in 4 GB; rely on the concurrency guard, not swap, there.
- Harden: SSH keys only (DigitalOcean images already disable password auth), `ufw` open on 22/80/443
  only, unattended-upgrades.
- **`moni.service` must set `MemorySwapMax=0`** (drop-in or unit). The app holds Tier-0 keys and
  plaintext bank credentials in RAM only (`AGENTS.md`; `security-design-principles.md` §20) — with
  swap enabled on the box, memory pressure could otherwise page them to disk, where a stolen disk or
  swap image recovers them. `MemorySwapMax=0` forbids the app cgroup — and the scrape/worker children
  it `spawn()`s, which inherit that cgroup — from ever swapping, so the app is OOM-killed (safe) rather
  than paged out. Verify during a real scrape: `grep VmSwap /proc/$(pgrep -f 'next start')/status` = 0.
- **Chrome runtime libs** (Ubuntu 24.04 `t64` names) + `kernel.apparmor_restrict_unprivileged_userns=0`
  (keeps the sandbox — **never** `--no-sandbox` on a box holding real credentials). Full list and
  reasoning: `israeli-scraper` skill.
- **Chrome install:** set `PUPPETEER_SKIP_DOWNLOAD=true` for `npm ci` (npm's auto-download is
  unreliable and aborts the install), then fetch Chrome-for-Testing manually to match
  `node -p "require('puppeteer').executablePath()"` and set `MONI_CHROME_PATH`. `release.sh` does
  this automatically.

## Database bootstrap (first time on a host)

- The database **must be named `moni`** — migration `0001` hardcodes `GRANT … ON DATABASE moni` (#8).
- The **first** migrate runs as the Postgres **superuser** (0001 creates the `moni_owner`/`moni_app`
  roles with placeholder passwords). Then **rotate both roles to strong passwords** and switch
  `DATABASE_URL_MIGRATE` to `moni_owner` for every later migration. Roles are cluster-level, so they
  survive a `DROP DATABASE` (see `reset-db.sh`).

## TLS — use DNS-01, not HTTP-01 (hard-won)

- **Let's Encrypt HTTP-01 / TLS-ALPN-01 does NOT work on this DO IP.** Primary validation succeeds,
  but LE's **remote (secondary) validation perspectives time out** — `"During secondary validation:
  <ip>: Timeout during connect"` — even though the IP is globally reachable (verified: 28/28
  check-host datacenter probes, letsdebug, and LE **staging** all reproduce it identically, so it is
  **not** transient, not rate-limiting, not IP reputation). It is LE's MPIC remote-perspective path
  to this IP; unfixable from the box.
- **Fix: DNS-01 via Cloudflare DNS.** Keep the zone **grey-cloud (DNS-only)** — orange-cloud would
  terminate TLS at Cloudflare and put a third party in the plaintext path, which Moni's threat model
  forbids. Caddy needs the DNS module: download a custom build from
  `caddyserver.com/api/download?os=linux&arch=amd64&p=github.com/caddy-dns/cloudflare`. Token
  (Zone:DNS:Edit, single zone) in `/etc/caddy/cf.env` (root, 600); a systemd drop-in points ExecStart
  at `/usr/local/bin/caddy-cf`, adds `EnvironmentFile=/etc/caddy/cf.env`, and **omits `--environ`**
  (else the token is printed to the journal).
- **Resolver gotcha:** systemd-resolved returns **SERVFAIL** for `_acme-challenge.<domain>` (breaks
  Caddy's zone detection) even when pointed at 1.1.1.1. Fix: a **direct** `/etc/resolv.conf` →
  `1.1.1.1` / `8.8.8.8`, then `chattr +i` so it survives reboots and cert renewals.
- HSTS is emitted by the app (`next.config.ts`), not Caddy — one source of truth (ADR 0004).

## Releasing a version

- **`/opt/moni/release.sh [ref]`** (in `deploy/` in the repo, copied to the box): **age-encrypted**
  pre-deploy backup (needs `AGE_RECIPIENT` from `/root/moni-backup.env`), fetch + checkout, `npm ci`
  (`PUPPETEER_SKIP_DOWNLOAD=true`), reconcile Chrome version, build, migrate (`moni_owner`,
  forward-only), restart, then health-check **`/api/health`** (checks Postgres connectivity + schema —
  a plain `/` only 307s regardless of DB). **Forward-only and non-destructive** — it never drops or
  recreates the DB. It is **not** atomic (in-place `npm ci`/build under the live service) and does not
  roll back on a failed health check — tracked, acceptable for a low-frequency single-owner deploy.
- **CI:** `.github/workflows/deploy.yml` fires on a **published GitHub Release** and SSHes the tag to
  the box, where a **forced-command** key in root's `authorized_keys` runs only `release.sh`. It first
  **refuses to deploy a SHA without a successful `ci.yml` run** (the four gates + build), so an
  un-green commit can't ship. Secrets: `DEPLOY_HOST`, `DEPLOY_SSH_KEY`.
- **Rewriting the DB** (beta only, when the owner explicitly asks) is a **separate** guarded script,
  `reset-db.sh --yes-destroy-moni-data` — never part of a release or CI.
- This Next version rewrites `tsconfig.json` and re-adds the CLAUDE.md agent block on `build`/`start`
  — expected, not a release failure.

## Off-box backups

`deploy/backup.sh` → `/opt/moni/backup.sh`, run nightly by `deploy/moni-backup.{service,timer}`. Dumps
roles + a `--create` DB as one stream, **age**-encrypts to a PUBLIC recipient (the box cannot read its
own backups), and uploads to Cloudflare R2 via rclone; keeps 14 encrypted copies locally.

Arm on a host (secrets never leave the box — the private age key stays off it):

```bash
apt-get install -y age
# rclone: do NOT apt-get it — Ubuntu's v1.60 throws `501 NotImplemented` against R2 (survives only
# via rclone's retry). Install the official binary instead:
curl -fsSL https://downloads.rclone.org/rclone-current-linux-amd64.zip -o /tmp/r.zip
unzip -oq /tmp/r.zip -d /tmp && install -m755 /tmp/rclone-*-linux-amd64/rclone /usr/bin/rclone

mkdir -p /root/.config/rclone
cat > /root/.config/rclone/rclone.conf <<EOF   # then chmod 600
[r2]
type = s3
provider = Cloudflare
region = auto
access_key_id = <R2_ACCESS_KEY_ID>             # an Object Read & Write token
secret_access_key = <R2_SECRET>
endpoint = https://<ACCOUNT_ID>.r2.cloudflarestorage.com
no_check_bucket = true                          # REQUIRED — else rclone pre-flights CreateBucket,
EOF                                             # which an object-scoped token 403s (mimics "no write")
cat > /root/moni-backup.env <<EOF               # then chmod 600
AGE_RECIPIENT=age1…                             # PUBLIC key only
RCLONE_REMOTE=r2:moni-backups
EOF
chmod 600 /root/.config/rclone/rclone.conf /root/moni-backup.env

install -m644 deploy/moni-backup.service deploy/moni-backup.timer /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now moni-backup.timer
/opt/moni/backup.sh && rclone ls r2:moni-backups   # verify an object lands off-box
```

**Restore test (#62):** the dump is `pg_dump --create` (embeds `CREATE DATABASE moni` + `\connect
moni`), so restore ONLY into an **isolated** cluster that has no `moni` DB — a stray `\connect` on the
live cluster would load into production. From a machine that HAS the private age key:

```bash
age -d -i key.txt moni-<ts>.sql.age | psql "postgresql://postgres@127.0.0.1/postgres"
```

Pragmatic bar: row counts match, `moni_owner`/`moni_app` roles + RLS policies present, `*_ct` columns
byte-intact. A full decrypt check needs the app's per-user key (passkey/password), so it is out of scope.

## Verified vs NOT (be honest about coverage)

- **Verified on the box (2026-08-11):** **Leumi** and **Isracard** scrape end-to-end — note Isracard
  worked from a DO datacenter IP, which **contradicts #49** ("Isracard/Amex broken from cloud ASNs");
  worth revisiting #49. Adding connections works. Login from **macOS** and **Android (Pixel 9A)** over
  HTTPS.
- **Off-box backups wired + verified (2026-08-12):** nightly timer armed; a manual `backup.sh`
  uploaded an age-encrypted dump to R2. The **restore test (#62) is still pending** (needs the private
  age key, off-box).
- **NOT yet verified from the box:** the other scrapers (Hapoalim, Discount, Cal, Max, One Zero, …),
  the investments workers (IBKR/SnapTrade/Schwab), BOI FX + Tiingo quote workers; the backup
  **restore test (#62)**; **scraper egress filtering (#56, still unbuilt)**; peak memory under a real scrape
  and concurrent-scrape behavior (no concurrency guard yet — `connector-interface.md` §7).
