-- Moni — RLS & roles migration (T3)
--
-- Layers roles + Row-Level Security on top of the T2 schema migration
-- (0000_nervous_master_mold.sql). Hand-authored, not drizzle-kit-generated —
-- drizzle-kit's schema diffing doesn't model roles/policies/triggers, so
-- this file was created via `drizzle-kit generate --custom` (empty-file +
-- journal-entry boilerplate only; all SQL below is hand-written) and is
-- applied by the same `drizzle-kit migrate` step as 0000, in one
-- transaction, per drizzle-orm's node-postgres migrator.
--
-- See: docs/security/security-design-principles.md §9-10,
--      docs/security/threat-model.md §6, docs/design/domain-layer.md §2,
--      docs/design/data-model.md §2.
--
-- ============================================================================
-- BOOTSTRAP NOTE — read before running for the first time
-- ============================================================================
-- `drizzle.config.ts` points `drizzle-kit migrate` at DATABASE_URL_MIGRATE
-- exclusively. This file creates the `moni_owner` and `moni_app` roles that
-- .env.example's DATABASE_URL_MIGRATE / DATABASE_URL already assume exist —
-- a chicken-and-egg problem on a brand-new database:
--
--   1. FIRST RUN ONLY: temporarily point DATABASE_URL_MIGRATE at the Docker
--      Postgres superuser (`postgresql://postgres:postgres@localhost:5432/moni`
--      locally — see docker-compose.yml's POSTGRES_USER/POSTGRES_PASSWORD),
--      not at `moni_owner`. `drizzle-kit migrate` will then run 0000 (create
--      tables, owned by `postgres`) and this file (0001) in one transaction:
--      0001 creates `moni_owner`/`moni_app`, transfers table ownership to
--      `moni_owner`, grants `moni_app` its RLS-gated access, and enables RLS.
--      Some statements here (GRANT CONNECT ON DATABASE, CREATE ROLE) require
--      superuser or database-owner privileges — another reason the first run
--      must be the superuser connection, not `moni_owner`.
--   2. AFTER the first run: switch DATABASE_URL_MIGRATE back to `moni_owner`
--      (the value already in .env.example) for all subsequent migrations.
--      `moni_owner` now owns every table and has USAGE+CREATE on the public
--      schema, so it can run future schema migrations unassisted. This file
--      is also safe to re-run as `moni_owner` — every statement in it is
--      idempotent (guarded role creation, ALTER...OWNER TO on an object it
--      already owns, GRANT/REVOKE, ENABLE/FORCE ROW LEVEL SECURITY, and
--      DROP POLICY IF EXISTS + CREATE POLICY / CREATE OR REPLACE TRIGGER) —
--      though in practice drizzle-kit's migration-hash tracking means it
--      won't be re-executed at all once recorded as applied.
--
-- Passwords below match the dev values already declared in .env.example
-- (`moni_app:moni_app_dev_password`, `moni_owner:moni_owner_dev_password`).
-- Production deployments must set real passwords — this file is a local-dev
-- bootstrap, not a production credential source.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Roles
-- ---------------------------------------------------------------------------
-- Postgres has no `CREATE ROLE IF NOT EXISTS`, so guard with a DO block —
-- this is what makes the migration rerunnable.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'moni_owner') THEN
    CREATE ROLE moni_owner LOGIN PASSWORD 'moni_owner_dev_password';
  END IF;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'moni_app') THEN
    -- Plain login role. NOT superuser, NOT a table owner — this is the
    -- runtime role the app/worker/MCP connect as, and the only role
    -- FORCE ROW LEVEL SECURITY (below) needs to bind, since non-owners are
    -- already subject to RLS by default.
    CREATE ROLE moni_app LOGIN PASSWORD 'moni_app_dev_password';
  END IF;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Database/schema-level grants
-- ---------------------------------------------------------------------------
GRANT CONNECT ON DATABASE moni TO moni_app;
--> statement-breakpoint
GRANT CONNECT ON DATABASE moni TO moni_owner;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO moni_app;
--> statement-breakpoint
-- moni_owner needs CREATE on the schema too — it's the DDL/migration role
-- (drizzle.config.ts), and must be able to run future schema migrations
-- unassisted once bootstrap is done.
GRANT USAGE, CREATE ON SCHEMA public TO moni_owner;
--> statement-breakpoint
-- moni_owner also needs database-level CREATE: drizzle-kit's own migrator
-- runs `CREATE SCHEMA IF NOT EXISTS drizzle` on every invocation to house
-- its `__drizzle_migrations` tracking table (below), and that statement's
-- permission check requires CREATE on the *database*, not just schema
-- "public" — Postgres checks it even when the schema already exists.
GRANT CREATE ON DATABASE moni TO moni_owner;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Schema object ownership → moni_owner
-- ---------------------------------------------------------------------------
-- Enum types are independent schema objects in Postgres. Owning the tables
-- that use them is not enough to ALTER the types in a later migration.
ALTER TYPE "account_classification" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TYPE "account_status" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TYPE "account_type" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TYPE "category_classification" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TYPE "entry_field_change_source" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TYPE "connection_status" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TYPE "reconcile_state" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TYPE "sync_run_status" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TYPE "sync_staging_scraper_status" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TYPE "account_balance_snapshot_source" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TYPE "entry_source" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TYPE "entry_status" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TYPE "entry_transaction_kind" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TYPE "entry_type" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TYPE "fx_status" OWNER TO moni_owner;
--> statement-breakpoint

ALTER TABLE "accounts" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TABLE "credit_card_details" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TABLE "categories" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TABLE "entry_field_changelog" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TABLE "merchants" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TABLE "recurring_series" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TABLE "rule_actions" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TABLE "rule_conditions" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TABLE "rules" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TABLE "transfers" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TABLE "connections" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TABLE "sync_runs" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TABLE "sync_staging" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TABLE "account_balance_snapshots" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TABLE "users" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TABLE "entries" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TABLE "entry_transactions" OWNER TO moni_owner;
--> statement-breakpoint
ALTER TABLE "fx_rates" OWNER TO moni_owner;
--> statement-breakpoint

-- drizzle-kit's own migrator creates a `drizzle.__drizzle_migrations`
-- tracking table (schema "drizzle") *before* running any migration file's
-- SQL, using whatever role is currently connected — on the very first
-- bootstrap run that's the Docker superuser, not moni_owner. Without this
-- transfer, every subsequent `drizzle-kit migrate` run as moni_owner fails
-- with "permission denied for schema drizzle" trying to read/write that
-- tracking table. Guarded by existence checks since a schema named
-- "drizzle" only exists once a migration has run at least once (true by
-- the time this statement executes, since it's created earlier in this
-- same migrate invocation, before the transaction wrapping this file began).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'drizzle') THEN
    ALTER SCHEMA drizzle OWNER TO moni_owner;
  END IF;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'
  ) THEN
    ALTER TABLE drizzle.__drizzle_migrations OWNER TO moni_owner;
  END IF;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Per-table grants for moni_app
-- ---------------------------------------------------------------------------
-- Blanket grant, then narrow fx_rates down to SELECT-only — RLS (below) is
-- the real gate for every other table, so precision here isn't load-bearing,
-- but fx_rates is global reference data written only by the FX background
-- job (data-model.md §5), never by moni_app.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO moni_app;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON "fx_rates" FROM moni_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. updated_at trigger function
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION moni_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. Row-Level Security — enable + force + tenant-isolation policy on every
--    user-owned table. fx_rates is the sole exception (§8 below): it has no
--    owner_id column, is global reference data, and RLS cannot and should
--    not apply to it.
--
--    current_setting('app.user_id', true) — the true (missing_ok) argument
--    is critical: it returns NULL instead of raising when app.user_id was
--    never set (a caller that forgot withUser(), per src/db/client.ts).
--    "owner_id = NULL" / "id = NULL" is never true in SQL, so an unset
--    app.user_id correctly yields ZERO ROWS for every policy below — fail
--    closed, not fail open. This is the single most important property in
--    this file (security-design-principles.md, "Sanity checks").
-- ---------------------------------------------------------------------------
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "users_tenant_isolation" ON "users";
--> statement-breakpoint
CREATE POLICY "users_tenant_isolation" ON "users"
  USING ("id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("id" = current_setting('app.user_id', true)::uuid);
--> statement-breakpoint

ALTER TABLE "accounts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "accounts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "accounts_tenant_isolation" ON "accounts";
--> statement-breakpoint
CREATE POLICY "accounts_tenant_isolation" ON "accounts"
  USING ("owner_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("owner_id" = current_setting('app.user_id', true)::uuid);
--> statement-breakpoint

ALTER TABLE "credit_card_details" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "credit_card_details" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "credit_card_details_tenant_isolation" ON "credit_card_details";
--> statement-breakpoint
CREATE POLICY "credit_card_details_tenant_isolation" ON "credit_card_details"
  USING ("owner_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("owner_id" = current_setting('app.user_id', true)::uuid);
--> statement-breakpoint

ALTER TABLE "categories" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "categories" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "categories_tenant_isolation" ON "categories";
--> statement-breakpoint
CREATE POLICY "categories_tenant_isolation" ON "categories"
  USING ("owner_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("owner_id" = current_setting('app.user_id', true)::uuid);
--> statement-breakpoint

ALTER TABLE "entry_field_changelog" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "entry_field_changelog" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "entry_field_changelog_tenant_isolation" ON "entry_field_changelog";
--> statement-breakpoint
CREATE POLICY "entry_field_changelog_tenant_isolation" ON "entry_field_changelog"
  USING ("owner_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("owner_id" = current_setting('app.user_id', true)::uuid);
--> statement-breakpoint

ALTER TABLE "merchants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "merchants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "merchants_tenant_isolation" ON "merchants";
--> statement-breakpoint
CREATE POLICY "merchants_tenant_isolation" ON "merchants"
  USING ("owner_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("owner_id" = current_setting('app.user_id', true)::uuid);
--> statement-breakpoint

ALTER TABLE "recurring_series" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "recurring_series" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "recurring_series_tenant_isolation" ON "recurring_series";
--> statement-breakpoint
CREATE POLICY "recurring_series_tenant_isolation" ON "recurring_series"
  USING ("owner_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("owner_id" = current_setting('app.user_id', true)::uuid);
--> statement-breakpoint

ALTER TABLE "rule_actions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "rule_actions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "rule_actions_tenant_isolation" ON "rule_actions";
--> statement-breakpoint
CREATE POLICY "rule_actions_tenant_isolation" ON "rule_actions"
  USING ("owner_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("owner_id" = current_setting('app.user_id', true)::uuid);
--> statement-breakpoint

ALTER TABLE "rule_conditions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "rule_conditions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "rule_conditions_tenant_isolation" ON "rule_conditions";
--> statement-breakpoint
CREATE POLICY "rule_conditions_tenant_isolation" ON "rule_conditions"
  USING ("owner_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("owner_id" = current_setting('app.user_id', true)::uuid);
--> statement-breakpoint

ALTER TABLE "rules" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "rules" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "rules_tenant_isolation" ON "rules";
--> statement-breakpoint
CREATE POLICY "rules_tenant_isolation" ON "rules"
  USING ("owner_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("owner_id" = current_setting('app.user_id', true)::uuid);
--> statement-breakpoint

ALTER TABLE "transfers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "transfers" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "transfers_tenant_isolation" ON "transfers";
--> statement-breakpoint
CREATE POLICY "transfers_tenant_isolation" ON "transfers"
  USING ("owner_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("owner_id" = current_setting('app.user_id', true)::uuid);
--> statement-breakpoint

ALTER TABLE "connections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "connections" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "connections_tenant_isolation" ON "connections";
--> statement-breakpoint
CREATE POLICY "connections_tenant_isolation" ON "connections"
  USING ("owner_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("owner_id" = current_setting('app.user_id', true)::uuid);
--> statement-breakpoint

ALTER TABLE "sync_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "sync_runs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "sync_runs_tenant_isolation" ON "sync_runs";
--> statement-breakpoint
CREATE POLICY "sync_runs_tenant_isolation" ON "sync_runs"
  USING ("owner_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("owner_id" = current_setting('app.user_id', true)::uuid);
--> statement-breakpoint

ALTER TABLE "sync_staging" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "sync_staging" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "sync_staging_tenant_isolation" ON "sync_staging";
--> statement-breakpoint
CREATE POLICY "sync_staging_tenant_isolation" ON "sync_staging"
  USING ("owner_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("owner_id" = current_setting('app.user_id', true)::uuid);
--> statement-breakpoint

ALTER TABLE "account_balance_snapshots" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "account_balance_snapshots" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "account_balance_snapshots_tenant_isolation" ON "account_balance_snapshots";
--> statement-breakpoint
CREATE POLICY "account_balance_snapshots_tenant_isolation" ON "account_balance_snapshots"
  USING ("owner_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("owner_id" = current_setting('app.user_id', true)::uuid);
--> statement-breakpoint

ALTER TABLE "entries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "entries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "entries_tenant_isolation" ON "entries";
--> statement-breakpoint
CREATE POLICY "entries_tenant_isolation" ON "entries"
  USING ("owner_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("owner_id" = current_setting('app.user_id', true)::uuid);
--> statement-breakpoint

ALTER TABLE "entry_transactions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "entry_transactions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "entry_transactions_tenant_isolation" ON "entry_transactions";
--> statement-breakpoint
CREATE POLICY "entry_transactions_tenant_isolation" ON "entry_transactions"
  USING ("owner_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("owner_id" = current_setting('app.user_id', true)::uuid);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 7. updated_at triggers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE TRIGGER "accounts_set_updated_at"
  BEFORE UPDATE ON "accounts"
  FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "credit_card_details_set_updated_at"
  BEFORE UPDATE ON "credit_card_details"
  FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "categories_set_updated_at"
  BEFORE UPDATE ON "categories"
  FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "merchants_set_updated_at"
  BEFORE UPDATE ON "merchants"
  FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "recurring_series_set_updated_at"
  BEFORE UPDATE ON "recurring_series"
  FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "rule_actions_set_updated_at"
  BEFORE UPDATE ON "rule_actions"
  FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "rule_conditions_set_updated_at"
  BEFORE UPDATE ON "rule_conditions"
  FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "rules_set_updated_at"
  BEFORE UPDATE ON "rules"
  FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "transfers_set_updated_at"
  BEFORE UPDATE ON "transfers"
  FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "connections_set_updated_at"
  BEFORE UPDATE ON "connections"
  FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "sync_runs_set_updated_at"
  BEFORE UPDATE ON "sync_runs"
  FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "sync_staging_set_updated_at"
  BEFORE UPDATE ON "sync_staging"
  FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "account_balance_snapshots_set_updated_at"
  BEFORE UPDATE ON "account_balance_snapshots"
  FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "users_set_updated_at"
  BEFORE UPDATE ON "users"
  FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "entries_set_updated_at"
  BEFORE UPDATE ON "entries"
  FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "entry_transactions_set_updated_at"
  BEFORE UPDATE ON "entry_transactions"
  FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "fx_rates_set_updated_at"
  BEFORE UPDATE ON "fx_rates"
  FOR EACH ROW EXECUTE FUNCTION moni_set_updated_at();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 8. fx_rates: intentionally NOT RLS-protected
-- ---------------------------------------------------------------------------
-- fx_rates has no owner_id column and is global reference data — readable by
-- all users, written only by the FX background job (data-model.md §2, §5).
-- This is not an oversight: enabling RLS on it would be a no-op at best
-- (there is no owner_id to key a policy on) and a footgun at worst if a
-- future column rename accidentally gave it one. No ALTER TABLE fx_rates
-- ENABLE ROW LEVEL SECURITY appears anywhere in this file, by design.
