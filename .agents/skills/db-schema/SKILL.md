# DB Schema Skill

Reason about and test Moni's database schema. Authoritative spec: @../../../docs/design/data-model.md — read it before changing schema.

## Table map (18 tables, src/db/schema/*.ts)
- **identity.ts**: users
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
```sql
-- table/RLS inventory
select relname, relrowsecurity, relforcerowsecurity from pg_class where relkind='r' and relnamespace='public'::regnamespace;
select * from pg_policies;
```
Connect as `moni_app` and `SELECT set_config('app.user_id', '<uuid>', true)` inside a transaction to see exactly what that user sees — this is what `withUser()` (`src/db/client.ts`) does under the hood.

## Pre-deploy DB check
`npm run db:migrate && npm run seed:demo && npm run test` — all three must succeed with no manual intervention (after the one-time role bootstrap on a brand-new database, documented in `drizzle/0001_rls_and_roles.sql`'s header).
