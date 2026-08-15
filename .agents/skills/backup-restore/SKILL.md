---
name: backup-restore
description: Backing up and restoring Moni's Postgres database — the age-encrypted off-box backup model, restoring onto a live box (scripts/restore.sh), the isolated-cluster restore test, and the non-negotiable safety rules. Use when taking, verifying, or restoring a backup, or recovering a host's data. For host provisioning / arming the nightly timer, see the deployment skill.
---

# Moni backups & restore

How Moni's data is backed up and restored. This skill owns the backup **model**
and the **restore** procedures; the `deployment` skill owns host provisioning and
**arming** the nightly backup (installing `age`/`rclone`, `/root/moni-backup.env`,
the `moni-backup.timer`).

## The backup model

- **`deploy/backup.sh`** (nightly via `moni-backup.timer`) dumps `pg_dumpall
  --globals-only` **then** `pg_dump --create moni` as **one stream**, `age`-encrypts
  it to a **PUBLIC** recipient, uploads to Cloudflare R2 via `rclone`, and keeps 14
  encrypted copies locally under `/root/moni-backups`.
- **The box cannot read its own backups.** The `age` recipient is a public key; the
  **private key lives OFF the box**. So every decrypt/restore happens on a machine
  that holds the private key — never on the box.
- `release.sh` (`predeploy-*.sql.age`) and `reset-db.sh` (`pre-reset-*.sql.age`)
  write the **same** encrypted stream shape, so any of these files restores
  identically: roles + database + RLS policies + rows, in one file.

## Safety rules (non-negotiable)

- **The private age key never touches the box** (disk, swap, logs). Restores decrypt
  locally and stream plaintext over SSH into the box's Postgres.
- **Verify a backup decrypts end-to-end BEFORE you wipe anything.** `age` errors on a
  truncated/corrupt file, so this is a real integrity gate:
  `age -d -i key.txt <dump>.sql.age > /dev/null`.
- `reset-db.sh` backs up **and** wipes in a single run, so its own `pre-reset` dump
  can't be verified before the drop. Take and verify a **separate** backup first
  (`backup.sh`), and restore from **that** if recovery is needed.

## Restore onto a live box — `scripts/restore.sh`

> **LUKS (#93 M2):** the box's Postgres lives in an encrypted container. After a reboot the DB is
> down until you run `moni-unlock` on the box (see the `deployment` skill). `restore.sh` streams into
> a **running** Postgres, so unlock first — otherwise the restore has nothing to load into.

Run from the machine holding the **private** key:

```bash
MONI_DOMAIN=finance.example AGE_IDENTITY=key.txt scripts/restore.sh <dump.sql.age> [ssh-target] [--yes]
# ssh-target defaults to root@$MONI_DOMAIN
```

It verifies the dump decrypts, prompts for a typed confirmation (or `--yes`), stops
the app, drops `moni WITH (FORCE)`, streams the decrypted dump over SSH into the
box's `psql` (**plaintext never lands on the box's disk**), restarts the app, and
health-checks `/api/health`. Pull the encrypted dump down first:

```bash
scp root@<box>:/root/moni-backups/<dump>.sql.age .
```

Expect benign `role "moni_owner" already exists` / `... "moni_app" already exists`
from the globals section when the roles survived on the target — `psql` continues
past them (`ON_ERROR_STOP` is off for the load).

## Restore into an isolated test cluster (the #62 restore test)

For a restore **test** — not recovering production — restore into an **isolated**
cluster that has **no** `moni` database. The dump embeds `CREATE DATABASE moni` +
`\connect moni`, so a stray `\connect` on a live cluster would load into production.
From a machine with the private key:

```bash
age -d -i key.txt moni-<ts>.sql.age | psql "postgresql://postgres@127.0.0.1/postgres"
```

## Verifying a restore

Pragmatic bar: row counts match, `moni_owner`/`moni_app` roles + RLS policies
present, `*_ct` columns byte-intact. The **only** full proof the encrypted `*_ct`
columns survived is a **real user login** — the per-user key (passkey/password)
unwraps them, which row counts alone can't confirm.
