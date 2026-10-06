---
name: new-box-setup
description: Agent playbook for bringing up a NEW Moni instance (cloud VPS or the user's own hardware at home) or MOVING an existing deployed instance to another host, provider, or location. Use whenever someone asks to deploy/install/self-host Moni for the first time, set up a new server or home box, change VPS provider or region, migrate or port the production box, or "move Moni somewhere else" — even if they don't say "box". Starts with read-only discovery of any existing box, asks the owner the decisions that are theirs, then walks provisioning, migration cutover, and verification checklists. Defers the how-to details to the deployment, backup-restore, and israeli-scraper skills.
---

# New box setup & migration

The **ordering** playbook for standing up a Moni host or moving one. It does not repeat
how-tos — those live in:

- `deployment` skill — topology, provisioning, Tier-0 hardening, LUKS, TLS/DNS-01, release flow, arming backups.
- `backup-restore` skill — backup model, `scripts/restore.sh`, safety rules.
- `israeli-scraper` skill — Chrome runtime libs and sandbox.

Read those sections when a step points at them. Use placeholders (`<host>`, `<domain>`) in anything
you write down; never commit the owner's domain, IPs, provider, or bucket names.

> **Not yet proven.** Moni has never actually been moved between providers. The migration order
> and provider-specific notes below are a first draft. Expect this skill to be **rewritten after the
> first real migration** — when you run it, record what was wrong and propose the fix to the owner
> (CLAUDE.md §6).

## 0. Bank reachability comes first

Israeli banks/card issuers may block some datacenter networks, so a cheap box in the wrong network
can be useless. **Before committing to a candidate host**, confirm it can reach the banks the owner
uses. A credential-free probe, `scripts/scraper-test/reachability-probe.mjs`, and a skill around it
are **planned / in progress on another branch** — use them if they've landed; otherwise ask the owner
to accept the risk or do a manual check (e.g. `curl -sI` to each bank's login page from the
candidate box). Don't depend on the probe existing.

## 1. Discovery — examine the existing box (if there is one)

**Rule: discovery is read-only.** No writes, restarts, installs, package changes, or `ufw`/`sshd`
edits on the source box. **Never print secrets** — no `cat` of any `.env`, `moni-secrets.env`,
`moni-backup.env`, rclone config, certbot credentials, age keys, or SSH keys; `ls -l`/`stat` only.

First, the box's own read-only verifier (asserts most of the posture in one shot):
`ssh root@<host> /root/verify-host.sh`. Then fill in the gaps:

| Area | Commands (run as `ssh root@<host> '…'`) |
|---|---|
| Connect | How did you get in? user, key, port; is there a provider web console? |
| OS / size | `uname -m; lsb_release -ds; nproc; free -h; df -h` |
| Disks / LUKS | `lsblk -o NAME,TYPE,SIZE,FSTYPE,MOUNTPOINTS; cat /etc/crypttab; grep -v '^#' /etc/fstab; cryptsetup status moni_secure` |
| Unlock flow | `ls -l /usr/local/sbin/moni-unlock; systemctl is-enabled moni postgresql caddy` (disabled = waits for manual unlock) |
| Services | `systemctl list-units --type=service --no-pager \| grep -Ei 'moni\|caddy\|postgres\|crypt'; systemctl cat moni.service; ls /etc/systemd/system/*.d` |
| Listeners | `ss -ltnp` — app, Postgres, Caddy admin must be loopback; only 22/80/443 public |
| Swap / cores | `swapon --show; sysctl kernel.core_pattern fs.suid_dumpable kernel.apparmor_restrict_unprivileged_userns; systemctl is-enabled apport` |
| Firewall | `ufw status verbose` — and ask the owner about a **provider cloud firewall** (invisible from the box) |
| SSH | `sshd -T \| grep -E '^(port\|permitrootlogin\|passwordauthentication\|pubkeyauthentication\|kbdinteractiveauthentication) '; ls /etc/ssh/sshd_config.d/; wc -l < ~/.ssh/authorized_keys; grep -c 'command=' ~/.ssh/authorized_keys` (the forced-command key is CI) |
| App layout | `ls -la /opt/moni /opt/moni/releases \| head; readlink /opt/moni/app; ls /opt/moni/chrome; node --version; pg_lsclusters` |
| TLS | `caddy version; cat /etc/caddy/Caddyfile; ls /etc/letsencrypt/renewal; grep -h '^authenticator' /etc/letsencrypt/renewal/*.conf; ls /etc/letsencrypt/renewal-hooks/deploy; lsattr /etc/resolv.conf` |
| Backups | `systemctl list-timers --all --no-pager \| grep -Ei 'moni\|certbot'; ls -l /opt/moni/backup.sh /root/moni-backup.env; ls /root/moni-backups \| tail -3` |
| Secrets | `ls -l /root/*.env /root/.config/rclone/ /opt/moni/app/.env` — note which are symlinks into the LUKS container |
| CI deploy | Locally: `gh secret list` (expect `DEPLOY_HOST`, `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`) |
| DNS | Locally: `dig +short <domain> A AAAA; dig +short NS <domain>` — and ask who the registrar/DNS provider is |

Summarize the findings for the owner in plain language before asking anything.

## 2. Decisions that belong to the owner

Ask these with **AskUserQuestion selectors** (options + a one-line consequence each), not prose.
Skip any the discovery already answered.

1. **Fresh install or migration with data?**
2. **Cloud VPS or home hardware?** (Home: power/ISP outages, dynamic IP, port-forwarding 80/443
   or DNS-01-only TLS, physical theft risk → LUKS matters more.)
3. **Provider + region** — only after the bank-reachability check (§0) passes for that network.
4. **Domain + DNS provider.** For a migration, strongly prefer **keeping the same domain** (see
   gotchas: passkeys are bound to it).
5. **TLS method** — DNS-01 via Certbot (the documented path) or HTTP-01 if the IP allows it.
6. **Hardening level** — LUKS-at-rest with **manual unlock after every reboot** (app is down until
   someone types the passphrase) vs. no LUKS; SSH lockdown (key-only, source-IP restriction, non-root).
7. **Backups** — off-box target (object storage / another machine), and who holds the **private
   age key** (must be off the box).
8. **Which bank/card connections** they will use — drives the reachability check and Chrome needs.
9. **AI backend** — none (rules-only works), hosted, or local model.

## 3. New-host provisioning checklist

- [ ] Bank reachability confirmed from this network (§0).
- [ ] **x86_64**, Ubuntu 24.04, RAM sized per `deployment` § Provisioning.
- [ ] SSH key-only, verified with `sshd -T` (don't assume the image's default); firewall 22/80/443.
- [ ] Packages: Node per `.nvmrc`, Postgres 16, Caddy ≥ 2.10, Chrome libs (`israeli-scraper`).
- [ ] `moni` service user, `/opt/moni` layout, `moni.service` + drop-ins from `deploy/` (`deployment` § Provisioning, § Tier-0 hardening).
- [ ] Database bootstrap — name `moni`, first migrate as superuser, rotate role passwords (`deployment` § Database bootstrap).
- [ ] `/root/moni-secrets.env` with `MONI_DOMAIN`; app env with `MONI_WEBAUTHN_RP_ID`/`MONI_WEBAUTHN_ORIGIN` matching the domain (see `.env.example`).
- [ ] If chosen: LUKS via `deploy/setup-luks-container.sh` (`deployment` § Encryption at rest); passphrase to the owner's password manager.
- [ ] TLS + DNS (`deployment` § TLS); DNS record points at the new host.
- [ ] Off-box backups armed and one object seen off-box (`deployment` § Off-box backups).
- [ ] CI deploy wired: forced-command key in `authorized_keys`, GitHub secrets set (§4 step 7).
- [ ] Post-setup verification (§5).

## 4. Migration cutover order

Do the steps in order; each gate must pass before the next. The old box stays intact and
authoritative until step 8.

1. **Provision the new host** fully (§3) on a **temporary hostname or IP**, with an empty DB. Prove
   a bank scrape works from it with a throwaway or owner-supervised connection if possible.
2. **Announce a freeze** — no syncs or edits on the old box from here on.
3. **Final backup on the old box** (`/opt/moni/backup.sh`), pull it locally, and **verify it decrypts**
   (`backup-restore` § Safety rules).
4. **Restore onto the new host** with `scripts/restore.sh` (`backup-restore` § Restore onto a live
   box). If LUKS: unlock first. **Pass the new host's address as the explicit `ssh-target`** — it
   defaults to `root@$MONI_DOMAIN`, which still resolves to the **old** box before the DNS switch, and
   its closing `/api/health` check also hits the domain (i.e. the old box), so its "healthy" means
   nothing here. Check the new host directly (`curl --resolve <domain>:443:<new-ip> …/api/health`).
5. **Carry over host config that is not in the dump** — app env values (WebAuthn RP ID/origin must
   stay identical), `/root/moni-secrets.env`, backup env, AI key. Copy secret files host-to-host
   with `scp` to a 600 path; never paste them into a chat or log.
6. **DNS switch** — lower the TTL a day ahead; update the record; issue/renew the cert on the new
   host; wait for propagation.
7. **CI deploy** — update `DEPLOY_HOST` and `DEPLOY_KNOWN_HOSTS`. Get the new host key **from the
   host itself** over a trusted channel (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the
   console, compare fingerprints) — **never a blind `ssh-keyscan`**. Then cut a release and watch it
   deploy.
8. **Verify** (§5) — including a real user login. Only then **decommission the old box**: take a
   last backup, keep it off-box, destroy the old disk/snapshots, remove its DNS records and its CI key.

## 5. Post-setup verification

- [ ] `/root/verify-host.sh` passes (after a deploy **and** after a reboot + unlock drill if LUKS).
- [ ] `https://<domain>/api/health` OK; cert issued by the intended method; renewal timer active.
- [ ] Real user login works (proves encrypted columns decrypt — `backup-restore` § Verifying a restore).
- [ ] Passkey unlock works and an existing bank connection syncs (proves the RP ID survived).
- [ ] During a scrape: `grep VmSwap /proc/$(systemctl show -p MainPID --value moni)/status` is 0.
- [ ] A backup runs and lands off-box; it decrypts with the off-box key.
- [ ] A CI release deploys end-to-end.

## Provider-portability gotchas

- **Changing the domain breaks bank credentials.** They are wrapped by passkeys bound to
  `MONI_WEBAUTHN_RP_ID`; a new domain means every user deletes and re-adds each bank connection.
- Some provider images enable root SSH **password** auth (DigitalOcean's disable it) — check, don't assume.
- LUKS manual unlock needs a provider **web console** or SSH after every reboot; confirm one exists.
- Cloud firewalls are provider-specific; fall back to `ufw` and keep both in sync if using both.
- Swap defaults differ by image (none, swapfile, zram) — place swap inside the LUKS container.
- Let's Encrypt HTTP-01 can fail from some IPs (remote-perspective timeouts); DNS-01 is the documented path.
- x86_64 only — Chrome-for-Testing has no linux-arm64 build (rules out most ARM boards and ARM VPSes).
- `DEPLOY_HOST` and pinned `DEPLOY_KNOWN_HOSTS` must change on a move; never refresh them by `ssh-keyscan`.
