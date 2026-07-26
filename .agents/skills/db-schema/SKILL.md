# DB Schema Skill

Reason about and test Moni's database schema. Authoritative spec: `../../../docs/design/data-model.md` — read it before changing schema.

## Table map (19 tables, src/db/schema/*.ts)
- **identity.ts**: users, user_unlock_methods (one row per unlock factor; wraps DK **and** CK under that factor's KEK — AAD binds to the *method row's* id, not `users.id`)
- **connectors.ts**: connections, sync_runs, sync_staging
- **accounts.ts**: accounts, credit_card_details
- **ledger.ts**: entries, entry_transactions
- **classification.ts**: categories, merchants, entry_field_changelog, rules, rule_conditions, rule_actions, recurring_series, transfers
- **dashboard.ts**: account_balance_snapshots
- **reference.ts**: fx_rates (only table with no owner_id / RLS — global, plaintext `rate`)

## Invariant checklist (verify after any schema change)
1. Every user-owned table: `uuid` PK, `owner_id`, `UNIQUE(owner_id, id)`, `createdAt`/`updatedAt`.
2. Every child->parent edge: composite FK `(owner_id, parentId)` -> `parent(owner_id, id)` via `foreignKey()`, never a bare single-column FK to a tenant table.
3. Tier-1 values are `bytea` `*_ct` columns (see `shared.ts`'s `bytea` customType); the table also carries `version int`.
4. No `reporting_amount_ct` anywhere — the reporting leg is derived on read (data-model.md §4.3).
5. `fx_rates.rate` is the only plaintext `numeric` money column.
6. New RLS-protected table -> also add role/policy/trigger statements to `drizzle/0001_rls_and_roles.sql` (drizzle-kit doesn't generate these; use `drizzle-kit generate --custom` for a new hand-authored migration).
7. **Add the new migration's filename to `MIGRATION_FILES` in `tests/db/setup-test-db.ts`.** The DB tests run against a separate `moni_test` database that this script — not drizzle-kit — migrates. Forget it and every `tests/db/**` test fails with a baffling `column "…" does not exist`, because the test DB is silently a schema behind. (It used to be worse: the script guarded on "does `users` exist", so an existing moni_test skipped *everything* after 0000. It now records applied files in `_moni_test_migrations`, so adding the filename is genuinely all you need.)
8. A table-level `GRANT` covers columns added later, so `ALTER TABLE … ADD COLUMN` needs no new grant. Verify with `information_schema.table_privileges` (table-level), not `column_privileges`.
9. Adding a column that an existing policy must permit? Check `pg_policies.cmd` — `users_tenant_isolation` is `FOR ALL` with a matching `WITH CHECK`, so writes to one's own row already pass. A `FOR SELECT`-only policy would not.

## Workflow
```bash
docker compose up -d                # local Postgres
# first run only: DATABASE_URL_MIGRATE -> postgres superuser (see .env.example bootstrap note)
npm run db:migrate                  # applies 0000 (schema) + 0001 (roles/RLS/triggers)
# then switch DATABASE_URL_MIGRATE back to moni_owner for all subsequent runs
npm run seed:demo                   # wipes + reseeds 2 demo users (Dana, Yossi) with full ledger data
npm run test                        # tests/db/** — RLS isolation, composite-FK, crypto, money, constraints
```

## Inspecting live state

**`psql` is not installed on the host — go through the container**, and connect as the
**`postgres` superuser**, not `moni_owner`:

```bash
docker compose exec -T postgres psql -U postgres -d moni -c "select email from users;"
```

`moni_owner` is subject to `FORCE ROW LEVEL SECURITY` too (drizzle/0001 §6), so without
`app.user_id` set it sees **zero rows in every user-owned table**. An empty result there means
"RLS is working", not "the table is empty" — do not conclude the database is blank. Only the
actual superuser bypasses RLS.

```sql
-- table/RLS inventory
select relname, relrowsecurity, relforcerowsecurity from pg_class where relkind='r' and relnamespace='public'::regnamespace;
select * from pg_policies;
```
Connect as `moni_app` and `SELECT set_config('app.user_id', '<uuid>', true)` inside a transaction to see exactly what that user sees — this is what `withUser()` (`src/db/client.ts`) does under the hood.

## Pre-deploy DB check
`npm run db:migrate && npm run seed:demo && npm run test` — all three must succeed with no manual intervention (after the one-time role bootstrap on a brand-new database, documented in `drizzle/0001_rls_and_roles.sql`'s header).

> **`seed:demo` runs `TRUNCATE … users CASCADE`** — it wipes *every* user in `moni`, including real
> accounts and real scraped bank transactions. That is intended: the owner uses a wipe to re-test
> the whole path (signup → onboarding → connect → scrape → settings) from a clean slate. Just say
> so plainly before running it, so the reset is a choice rather than a surprise.
>
> `npm run test` never touches `moni` — DB tests run against the separate `moni_test` database
> (`tests/db/setup-test-db.ts`).
