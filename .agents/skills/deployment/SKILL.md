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
  swap** (OOM insurance) — two concurrent scrapes do not fit in 4 GB.
- Harden: SSH keys only (DigitalOcean images already disable password auth), `ufw` open on 22/80/443
  only, unattended-upgrades.
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

- **`/opt/moni/release.sh [ref]`** (in `deploy/` in the repo, copied to the box): pre-deploy
  `pg_dump`, fetch + checkout, `npm ci` (`PUPPETEER_SKIP_DOWNLOAD=true`), reconcile Chrome version,
  build, migrate (`moni_owner`, forward-only), restart, health-check. **Forward-only and
  non-destructive** — it never drops or recreates the DB.
- **CI:** `.github/workflows/deploy.yml` fires on a **published GitHub Release** and SSHes the tag to
  the box, where a **forced-command** key in root's `authorized_keys` runs only `release.sh`. Secrets:
  `DEPLOY_HOST`, `DEPLOY_SSH_KEY`.
- **Rewriting the DB** (beta only, when the owner explicitly asks) is a **separate** guarded script,
  `reset-db.sh --yes-destroy-moni-data` — never part of a release or CI.
- This Next version rewrites `tsconfig.json` and re-adds the CLAUDE.md agent block on `build`/`start`
  — expected, not a release failure.

## Verified vs NOT (be honest about coverage)

- **Verified on the box (2026-08-11):** **Leumi** and **Isracard** scrape end-to-end — note Isracard
  worked from a DO datacenter IP, which **contradicts #49** ("Isracard/Amex broken from cloud ASNs");
  worth revisiting #49. Adding connections works. Login from **macOS** and **Android (Pixel 9A)** over
  HTTPS.
- **NOT yet verified from the box:** the other scrapers (Hapoalim, Discount, Cal, Max, One Zero, …),
  the investments workers (IBKR/SnapTrade/Schwab), BOI FX + Tiingo quote workers; **off-box backups +
  a restore test**; **scraper egress filtering (#56, still unbuilt)**; peak memory under a real scrape
  and concurrent-scrape behavior (no concurrency guard yet — `connector-interface.md` §7).
