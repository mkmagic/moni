---
name: new-box-setup
description: Agent playbook for bringing up a NEW Moni instance (cloud VPS or the user's own hardware at home) or MOVING an existing deployed instance to another host, provider, or location. Use whenever someone asks to deploy/install/self-host Moni for the first time, set up a new server or home box, change VPS provider or region, migrate or port the production box, or "move Moni somewhere else" — even if they don't say "box". Part A is a fresh setup, Part B a migration with data; both are ordered checklists. Defers the how-to details to the deployment, backup-restore, and israeli-scraper skills.
---

# New box setup & migration

The **ordering** playbook for standing up a Moni host (Part A) or moving one with its data
(Part B). How-tos live in other skills — follow the links:

- `deployment` — topology, Tier-0 hardening, LUKS, TLS/DNS-01, release flow, arming backups.
- `backup-restore` — backup model, `scripts/restore.sh`, safety rules.
- `israeli-scraper` — Chrome runtime libs and sandbox.

Use placeholders (`<host>`, `<domain>`, `<new-ip>`) in anything you write down; never commit the
owner's domain, IPs, provider, or bucket names.

> **Not yet proven.** Moni has never actually been moved between providers, and Part A has only
> been done once, by hand. Both Parts were checked against the live host but are a first draft.
> Expect this skill to be **rewritten after the first real migration**. When you run it, record what
> was wrong and propose the fix to the owner (CLAUDE.md §6).

## Common ground (read before either Part)

### C1. Bank reachability comes first

Israeli banks and card issuers may block some datacenter networks, so a cheap box on the wrong
network can be useless. **Before committing to a candidate host**, confirm it can reach the
banks the owner uses. A credential-free probe, `scripts/scraper-test/reachability-probe.mjs`, and a
skill around it are **planned / in progress on another branch**. Use them if they've landed.
Otherwise do a manual `curl -sI` to each bank's login page from the candidate box, or have the owner
accept the risk.

### C2. Decisions that belong to the owner

Ask these with **AskUserQuestion selectors** (options + a one-line consequence each), not prose.
Skip any that discovery already answered.

1. **Fresh install (Part A) or migration with data (Part B)?**
2. **Cloud VPS or home hardware?** Home means power/ISP outages, a dynamic IP, forwarding
   80/443 (or DNS-01-only TLS), and physical theft risk, which makes LUKS matter more.
3. **Provider + region**, decided only after C1 passes for that network.
4. **Domain + DNS provider.** For a migration, keep the **same domain**: passkeys are bound to it (C4).
5. **Hardening level.** LUKS at rest with a **manual unlock after every reboot** (the app is down
   until someone types the passphrase), or no LUKS. SSH lockdown: key-only, a source-IP limit, non-root.
6. **Backups.** The off-box target, and who holds the **private age key** (never the box).
7. **Which bank/card connections**, which drive C1. Also optional features: an AI backend (none is
   fine, rules-only works) and Tiingo quotes.

### C3. Host file map (what the box needs; names only — never print values)

- **Service user** `moni`, home **`/opt/moni`** (not `/home/moni`). Releases live in
  `/opt/moni/releases/<sha>`, and `/opt/moni/app` is a symlink to the live one.
- **`/root/moni-secrets.env`** (root 600) holds `PGSU, OWNERPW, APPPW, SIGNUP, MIGRATE_STEADY`
  (the `moni_owner` URL) and `MONI_DOMAIN`. `release.sh` refuses to run without `MIGRATE_STEADY` +
  `MONI_DOMAIN`.
- **App env `/opt/moni/shared/.env`** (moni 600). Each release's `.env` is a symlink to it. With LUKS
  it is itself a symlink to `/mnt/secure/app/.env`. Variables: `NODE_ENV, DATABASE_URL,
  MONI_WEBAUTHN_RP_ID, MONI_WEBAUTHN_ORIGIN, MONI_SIGNUP_TOKEN, MONI_CHROME_PATH` (rewritten by
  `release.sh`). Optional: `MONI_TIINGO_TOKEN, MONI_TIINGO_MULTI_USER_AUTHORIZED` (quotes),
  `MONI_LLM_API_KEY` (AI). See `.env.example`.
- **`/root/moni-backup.env`** (root 600) holds `AGE_RECIPIENT` (public) and `RCLONE_REMOTE`.
  The rclone config is at `/root/.config/rclone/rclone.conf`.
- **`/etc/caddy/moni.env`** (root 644) holds `MONI_DOMAIN=<domain>`. Caddy's override and the
  certbot hook both need it. `release.sh` does **not** create it.
- **Certbot DNS token**: `/root/.secrets/certbot/<dns>.ini` (dir 700, file 600). It is on the
  plaintext root disk, outside LUKS.
- **Sysctl**: `/etc/sysctl.d/60-moni-hardening.conf` (`fs.suid_dumpable=0`,
  `kernel.core_pattern=|/bin/false`), `99-moni-chrome.conf`
  (`kernel.apparmor_restrict_unprivileged_userns=0`), `99-moni.conf` (`vm.swappiness=10`). Apport
  is off: `enabled=0` in `/etc/default/apport`, and `apport.service` is disabled.
- **What `release.sh` refreshes** on every deploy: `moni.service`, the Caddyfile + Caddy override,
  `release.sh` itself, `/root/verify-host.sh`, and Chrome. **What it never touches** (you must install
  these yourself): `/opt/moni/backup.sh`, the `moni-backup.{service,timer}` units, `moni-unlock`,
  the certbot deploy hook, sysctl/apport, the LUKS drop-ins, and `/etc/caddy/moni.env`.
- Postgres is distro-default (no custom `postgresql.conf`). Logs are not migrated.

### C4. Gotchas that change what you do

- **The domain is load-bearing.** Bank credentials are wrapped by passkeys bound to
  `MONI_WEBAUTHN_RP_ID`. A new domain means every user deletes and re-adds every bank connection.
  Logging in via a temporary hostname or a bare IP also fails.
- **Health checks follow DNS.** `release.sh`, `moni-unlock`, `verify-host.sh` and `restore.sh` all
  curl `https://$MONI_DOMAIN/api/health`. If the domain still points elsewhere, a "pass" is
  meaningless, and a down old box can trigger a wrong rollback.
- Some provider images enable root SSH **password** auth. Check with `sshd -T`, don't assume.
  Test key login **before** disabling passwords.
- The LUKS manual unlock needs a provider **web console** or SSH after every reboot. Confirm one
  works before the first reboot drill. Keep unattended-upgrades `Automatic-Reboot` false.
- Cloud firewalls are provider-specific. Fall back to `ufw` (22/80/443 tcp), and keep the two in
  sync if you use both.
- Swap defaults differ by image (none, a swapfile, zram). Swap belongs inside the LUKS container.
- Let's Encrypt HTTP-01 can fail from some IPs; DNS-01 is the documented path.
- **x86_64 only.** Chrome-for-Testing has no linux-arm64 build.
- Don't recreate provider-specific agents or repos from the old image (droplet agents, VPC
  scripts, provider resolver drop-ins).
- **rclone**: use the official binary. Don't install apt's `rclone`, and `apt-get remove` it if
  present: an upgrade would overwrite the binary with a version that breaks uploads.

---

## Part A — Fresh setup (no existing data)

Follow in order; tick each box.

1. [ ] **C1 passes** for the candidate network; C2 answered.
2. [ ] **OS**: x86_64 Ubuntu 24.04, RAM sized per `deployment` § Provisioning. Timezone UTC.
   SSH key-only (verify with `sshd -T`). Firewall 22/80/443. Stock unattended-upgrades with
   `Automatic-Reboot` false.
3. [ ] **Packages**: Node from the **NodeSource** repo for the `.nvmrc` major. Caddy from the **Caddy
   stable** repo (Ubuntu's is < 2.10 and fails `request_body`). Plus `postgresql-16`, `age`, `unzip`,
   `curl`, `sudo`, `certbot` + its DNS plugin, the Chrome runtime libs (`israeli-scraper`), and
   official rclone (C4).
4. [ ] **Sysctl + apport** files from C3, then `sysctl --system` and `systemctl disable --now apport`.
5. [ ] **User + dirs**: `moni` system user with home `/opt/moni`; `/opt/moni/shared` (moni 700).
   The `caddy` group comes from the Caddy package.
6. [ ] **DNS**: point `<domain>` at the host (lower the TTL first).
7. [ ] **Secrets**: generate fresh values for `/root/moni-secrets.env` (C3); set `MONI_WEBAUTHN_*`
   to the final domain.
8. [ ] **Database bootstrap** (`deployment` § Database bootstrap): create DB `moni`, run the first
   migrate as superuser from a checkout of the release SHA, **rotate** both role passwords, then
   write `MIGRATE_STEADY` and `DATABASE_URL` with the new passwords.
9. [ ] **TLS**: write `/etc/caddy/moni.env`, the DNS token file (C3), and install
   `deploy/certbot-deploy-hook.sh` as `/etc/letsencrypt/renewal-hooks/deploy/moni-caddy` (755).
   First issuance: `certbot certonly --dns-<plugin> --dns-<plugin>-credentials <ini>
   --dns-<plugin>-propagation-seconds 30 --key-type ecdsa -d <domain> --deploy-hook
   /etc/letsencrypt/renewal-hooks/deploy/moni-caddy`. Hooks in that directory run only on
   *renew*, so without `--deploy-hook` the first certificate never reaches `/etc/caddy/certs`.
   Then check `/etc/caddy/certs/{fullchain,privkey}.pem` are root:caddy 640,
   `systemctl is-enabled certbot.timer`, and `certbot renew --dry-run`. If DNS-01 lookups fail,
   apply the resolver pin in `deployment` § TLS. It may be unnecessary now that Certbot talks to the
   DNS API, so verify before pinning.
10. [ ] **Backups** (`deployment` § Off-box backups): `/root/moni-backup.env`, the rclone config,
    `install -m700 deploy/backup.sh /opt/moni/backup.sh`, the `moni-backup.*` units, and enable the
    timer. Run once and see the object land off-box. Retention, if any, is a bucket lifecycle rule
    at the storage provider.
11. [ ] **LUKS (if chosen)** (`deployment` § Encryption at rest): `deploy/setup-luks-container.sh
    create` installs `moni-unlock` and the `20-secure-store.conf` drop-ins for `moni` and
    `postgresql@`. Place the app env **directly** at `/mnt/secure/app/.env` (moni 600) and
    `ln -s` it to `/opt/moni/shared/.env`. The script's `migrate` only moves `/opt/moni/app/.env`,
    which doesn't exist yet, and `verify-host` fails on a plaintext secret. Verify a backup decrypts
    off-box, then `migrate`. The passphrase goes to the owner's password manager. The container needs
    ≥ 20 GiB free on the root disk. Without LUKS: write the app env at `/opt/moni/shared/.env`.
12. [ ] **Bootstrap for the first release.** `release.sh` can't install itself, and it refuses unless
    the live unit already has `MemorySwapMax=0` + `LimitCORE=0`:
    `install -m755 deploy/release.sh /opt/moni/release.sh`;
    `install -m644 deploy/moni.service /etc/systemd/system/`; `systemctl daemon-reload`.
    Enable the unit only if there's no LUKS; with LUKS, `moni-unlock` starts it.
    `release.sh` also needs `/root/moni-backup.env` and an existing `moni` DB (it runs a predeploy dump).
13. [ ] **CI deploy**: generate an ed25519 pair. Append the public key to `/root/.ssh/authorized_keys`
    as
    `command="/opt/moni/release.sh",no-agent-forwarding,no-port-forwarding,no-pty,no-X11-forwarding ssh-ed25519 AAAA… moni-ci`.
    Set `DEPLOY_HOST`, `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS` with `gh secret set … --env production`.
    Take the host key from the box itself (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` over a
    trusted channel) — **never a blind `ssh-keyscan`**. Cut a release and watch it deploy.
14. [ ] **Verify** (§ Verification), including a reboot + unlock drill if LUKS.

---

## Part B — Migration (existing instance, data included)

The old box stays intact and authoritative until step B4. **The domain stays the same** (C4).

### B1. Discover the old box — read-only

No writes, restarts, installs, or config edits on the source box. **Never print secrets**: no
`cat` of any env file, rclone config, certbot `.ini`, age key, or SSH private key. Use `ls -l`/`stat`;
for env files, list variable **names** at most. Start with `ssh root@<old> /root/verify-host.sh`,
then:

| Area | Commands (`ssh root@<old> '…'`) |
|---|---|
| OS / size | `uname -m; lsb_release -ds; nproc; free -h; df -h` |
| LUKS | `lsblk -o NAME,TYPE,SIZE,FSTYPE,MOUNTPOINTS; cat /etc/crypttab; grep -v '^#' /etc/fstab; cryptsetup status moni_secure` |
| Services | `systemctl is-enabled moni postgresql@16-main caddy moni-backup.timer certbot.timer; systemctl cat moni.service; ls /etc/systemd/system/*.d` |
| Listeners | `ss -ltnp` (app, Postgres, Caddy admin on loopback only) |
| Hardening | `swapon --show; ls /etc/sysctl.d/; sysctl kernel.core_pattern fs.suid_dumpable vm.swappiness kernel.apparmor_restrict_unprivileged_userns` |
| Firewall / SSH | `ufw status verbose; sshd -T \| grep -E '^(permitrootlogin\|passwordauthentication\|pubkeyauthentication) '; grep -c 'command=' ~/.ssh/authorized_keys` (ask about a provider cloud firewall) |
| TLS | `caddy version; cat /etc/caddy/Caddyfile /etc/caddy/moni.env; ls /etc/letsencrypt/renewal /etc/letsencrypt/renewal-hooks/deploy; grep -hE '^(authenticator\|key_type\|dns_.*propagation)' /etc/letsencrypt/renewal/*.conf` |
| Secrets | `ls -l /root/*.env /root/.secrets/certbot /root/.config/rclone /opt/moni/shared/.env` |
| Backups | `systemctl list-timers --all --no-pager \| grep moni; ls /root/moni-backups \| tail -3; dpkg -l rclone` |
| CI / DNS | Locally: `gh secret list --env production; dig +short <domain> A AAAA; dig +short NS <domain>` |

Summarize the findings for the owner in plain language, then ask the C2 questions that remain.

### B2. Build the new host

Do Part A steps **1–5 and 9–12**, with these changes:

- **Skip Part A step 6 (DNS) and step 8 (bootstrap + rotation).** Create an empty `moni` DB only.
  The restore brings the roles **with the old box's passwords**. Rotating now would break
  `DATABASE_URL`/`MIGRATE_STEADY` the moment the restore runs.
- **Copy, don't regenerate**: `/root/moni-secrets.env`, the app env, `/root/moni-backup.env`, and the
  rclone config, **byte-for-byte** with `scp` to 600 paths (host to host, never through chat or logs).
  Rotate role passwords afterwards if wanted, updating both env files. With LUKS, the app env goes
  to `/mnt/secure/app/.env` (step 11).
- **Backup timer**: the copied backup env points at the **same** off-box remote. Install the units,
  but don't `enable` the timer until after cutover, so empty-DB dumps don't mix with real ones.
  A manual `backup.sh` run (for the LUKS gate) is fine.
- **DNS token**: create a **new** single-zone token for the new box rather than copying the old one.
- **Pin the domain locally**: add `127.0.0.1 <domain>` to the new host's `/etc/hosts`, so every health
  check (C4) hits the new box. The DNS-01 cert is valid before the switch. **Remove the pin after
  cutover.**
- **CI line**: copy it verbatim from the old `authorized_keys` (a public key isn't secret), or
  generate a new pair (Part A step 13). Don't change the GitHub secrets yet.
- Don't copy debris: the Chrome crash-report or cache dirs under `/opt/moni`, old `*.pre-*`/legacy
  script copies, stale SSH key pairs, or `/mnt/secure/tmp/*`.

### B3. Cutover

1. [ ] **Rehearse TLS**: `curl --resolve <domain>:443:<new-ip> -sI https://<domain>/` shows a valid
   cert. There's no app yet, so a 502 is fine.
2. [ ] **Freeze**: no syncs or edits on the old box from here on.
3. [ ] **Final backup** on the old box (`/opt/moni/backup.sh`). Pull it locally and **verify it
   decrypts** (`backup-restore` § Safety rules).
4. [ ] **Restore onto the new host** (`backup-restore` § Restore onto a live box). If LUKS, unlock
   first. **Pass the new host as the explicit `ssh-target`** (the default `root@$MONI_DOMAIN` is the
   old box). No release is on the box yet, so the script's closing app start and health check fail.
   That's expected: the `users=` count it prints first is the real gate.
5. [ ] **First release, by hand.** CI can't reach the new box yet, and a release couldn't run before
   the restore (it migrates as `moni_owner`, which the restore creates). On a laptop at the release
   SHA: `npm ci && npm run build && deploy/package-release.sh <sha>`, then
   `ssh root@<new> "/opt/moni/release.sh deploy <sha> <sha256-of-tarball>" < moni-release.tar.gz`.
   Its health check is trustworthy only because of the new host's `/etc/hosts` pin.
6. [ ] **Verify before DNS**: `/root/verify-host.sh` on the new box. Then point `<domain>` at
   `<new-ip>` in **your laptop's** `/etc/hosts` and do a real login + passkey unlock. Undo the pin.
7. [ ] **DNS switch** (TTL lowered a day ahead). Wait for propagation, then **remove the new
   host's `/etc/hosts` pin**.
8. [ ] **CI**: update `DEPLOY_HOST` and `DEPLOY_KNOWN_HOSTS` (and `DEPLOY_SSH_KEY` if you made a new
   pair) with `--env production`. Get the host key from the new box over a trusted channel; never
   `ssh-keyscan`. Cut a release and watch it deploy.
9. [ ] **Full verification** (§ Verification).

### B4. Decommission (after verification)

The owner just shuts the old VM down, so no on-box cleanup is needed. The **off-box** revocations
are the part that matters:

- [ ] Remove the old box's deploy keys from GitHub (`gh repo deploy-key list`) and any CI key that
  only it used.
- [ ] Revoke **every** DNS API token the old box held at the DNS provider: the certbot `.ini`, plus
  any older Caddy-era token.
- [ ] Confirm `DEPLOY_HOST`/`DEPLOY_KNOWN_HOSTS` point at the new box (B3.8).
- [ ] Keep the last old-box backup off-box. Then destroy the old VM **and** its provider snapshots
  and backups: old plaintext blocks survive in snapshots.

---

## Verification (both Parts)

- [ ] `/root/verify-host.sh` passes after a deploy **and** after a reboot + `moni-unlock` drill (LUKS).
- [ ] `https://<domain>/api/health` OK from outside; the cert came from the intended method;
      `certbot.timer` active.
- [ ] Real user login works (encrypted columns decrypt; see `backup-restore` § Verifying a restore).
- [ ] Passkey unlock works and a bank connection syncs (proves the RP ID survived).
- [ ] During a scrape: `grep VmSwap /proc/$(systemctl show -p MainPID --value moni)/status` is 0.
- [ ] A backup runs, lands off-box, and decrypts with the off-box key.
- [ ] A CI release deploys end-to-end.
