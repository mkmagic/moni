// Bootstraps an ISOLATED `moni_test` database on the same local Postgres
// instance as the shared dev `moni` database (docker-compose.yml), and
// applies the committed migrations to it directly via `pg`, bypassing
// drizzle-kit entirely.
//
// Why not drizzle-kit: `drizzle.config.ts` owns `DATABASE_URL_MIGRATE` for
// the real `moni` database, and another agent/process may concurrently run
// `drizzle-kit migrate` / seed tooling against it. Pointing a second
// drizzle-kit invocation at `moni_test` would mean juggling env vars a
// concurrent process is also reading, and a second, unrelated
// `__drizzle_migrations` bookkeeping table. A hand-rolled `pg` script avoids
// all of that: it never touches `moni`'s env vars or migration state.
//
// The script reproduces drizzle-kit's own convention for splitting a
// migration file into individual statements — splitting on the literal
// `--> statement-breakpoint` marker drizzle-kit inserts between them — and
// applies all files in one transaction, exactly as
// `drizzle/0001_rls_and_roles.sql`'s header comment documents drizzle-kit
// doing for the real database (roles/grants are idempotent, so re-running
// this against an already-migrated `moni_test` — which we avoid anyway via
// the `users` table existence check below — would still be safe).
//
// Known limitation, worth flagging explicitly: 0001_rls_and_roles.sql
// hardcodes the literal database name "moni" in two bootstrap-only grants
// (`GRANT CONNECT ON DATABASE moni ...`, `GRANT CREATE ON DATABASE moni TO
// moni_owner`). Run verbatim against moni_test, those two statements
// harmlessly re-assert already-existing grants on the *real* `moni`
// database (idempotent, no rows/data touched — they don't violate the "do
// not touch moni" rule in any observable way) rather than granting anything
// on moni_test. This is inconsequential here: Postgres grants CONNECT to
// PUBLIC on every newly created database by default, so moni_app can reach
// moni_test regardless of that misdirected grant; and since this script
// (not drizzle-kit) is what applies schema here, moni_owner never needs
// `CREATE ON DATABASE moni_test` for a `drizzle` bookkeeping schema the way
// drizzle-kit's own migrator would.
import { Client } from "pg";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "drizzle");
const MIGRATION_FILES = [
  "0000_nervous_master_mold.sql",
  "0001_rls_and_roles.sql",
  "0002_auth_lookup.sql",
  "0003_polite_thunderball.sql",
  "0004_user_unlock_methods_rls_and_roles.sql",
  "0005_open_vargas.sql",
  "0006_burly_karma.sql",
  "0007_category_suggestions_rls_and_roles.sql",
  "0008_drop_category_suggestions.sql",
  "0009_category_rejections.sql",
  "0010_category_rejections_rls_and_roles.sql",
  "0011_recurring_view.sql",
  "0012_slim_malcolm_colcord.sql",
  "0013_clear_password_wrapped_credential_key.sql",
  "0014_grey_logan.sql",
  "0015_investment-rls-and-lifecycle.sql",
  "0016_fx_rates_boi_writer.sql",
  "0017_enum-ownership-repair.sql",
  "0018_snaptrade_source.sql",
  "0019_snaptrade_sync_run_check.sql",
  "0020_thin_umar.sql",
  "0021_merchant_lookups_rls_and_roles.sql",
  "0022_installment_total_currency.sql",
  "0023_budget_tables.sql",
  "0024_budget_rls_and_roles.sql",
  "0025_long_term_savings_tables.sql",
  "0026_long_term_savings_rls_and_roles.sql",
  "0027_long_term_savings_investment_expense_rate.sql",
  "0028_agent_tokens.sql",
  "0029_agent_tokens_rls_and_roles.sql",
  "0030_agent_access_log.sql",
  "0031_agent_access_log_rls_and_roles.sql",
  "0032_agent_token_expiry_nullable.sql",
  "0033_zippy_firedrake.sql",
  "0034_mcp_oauth_grants_rls_and_roles.sql",
  "0035_messy_ser_duncan.sql",
  "0036_mcp_oauth_auth_codes_rls_and_roles.sql",
  "0037_mean_runaways.sql",
  "0038_ambiguous_charles_xavier.sql",
  "0039_remarkable_stellaris.sql",
];

/** Bookkeeping for which of MIGRATION_FILES this database has already seen.
 * Deliberately not drizzle's `__drizzle_migrations` — this script owns
 * moni_test's schema state and must not be confused with drizzle-kit's
 * bookkeeping for the real `moni` database (see the header comment). */
const APPLIED_TABLE = "_moni_test_migrations";

export const TEST_DB_NAME = "moni_test";

const SUPERUSER_MAINTENANCE_URL =
  process.env.TEST_SUPERUSER_URL ?? "postgresql://postgres:postgres@localhost:5432/postgres";

function withDatabase(connectionString: string, dbName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${dbName}`;
  return url.toString();
}

/**
 * Superuser connection to moni_test. `moni_owner` is *also* subject to
 * FORCE ROW LEVEL SECURITY (drizzle/0001_rls_and_roles.sql §6), so it can't
 * be used to seed rows across multiple owners for cross-tenant fixtures —
 * only the actual Postgres superuser can bypass RLS. This is what
 * tests/db/helpers.ts exposes for fixture setup/teardown and system-catalog
 * structural assertions.
 */
export const TEST_SUPERUSER_DATABASE_URL = withDatabase(SUPERUSER_MAINTENANCE_URL, TEST_DB_NAME);

/**
 * The RLS-subject app role's connection to moni_test — what `withUser()`
 * (src/db/client.ts) is pointed at for every DB test, via `DATABASE_URL`
 * (see vitest.setup.ts). `TEST_DATABASE_URL` overrides the default for a
 * non-standard local Postgres setup.
 */
export const TEST_APP_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://moni_app:moni_app_dev_password@localhost:5432/moni_test";

// Fixed keys for pg_advisory_lock, namespaced away from anything the app
// itself might one day lock on. Serializes bootstrap across vitest's
// parallel worker processes so two workers never race to CREATE DATABASE /
// apply migrations concurrently.
const CREATE_DB_LOCK_KEY = 727_274;
const MIGRATE_LOCK_KEY = 727_275;

async function databaseExists(client: Client, dbName: string): Promise<boolean> {
  const { rows } = await client.query("select 1 from pg_database where datname = $1", [dbName]);
  return rows.length > 0;
}

async function createDatabaseIfMissing(): Promise<void> {
  const client = new Client({ connectionString: SUPERUSER_MAINTENANCE_URL });
  await client.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [CREATE_DB_LOCK_KEY]);
    try {
      if (!(await databaseExists(client, TEST_DB_NAME))) {
        // CREATE DATABASE cannot run inside a transaction block; this client
        // issues it as a plain statement outside any BEGIN, so that's fine.
        await client.query(`CREATE DATABASE ${TEST_DB_NAME}`);
      }
    } finally {
      await client.query("select pg_advisory_unlock($1)", [CREATE_DB_LOCK_KEY]);
    }
  } finally {
    await client.end();
  }
}

/**
 * Which migration files this database has already had applied.
 *
 * Back-fills the bookkeeping table for a moni_test created before it existed:
 * if `users` is present but the table isn't, every migration up to and
 * including 0004 must already have run (that was the complete list at the
 * time), so they are recorded as applied rather than re-run.
 */
async function appliedMigrations(client: Client): Promise<Set<string>> {
  await client.query(
    `create table if not exists ${APPLIED_TABLE} (
       file text primary key,
       applied_at timestamptz not null default now()
     )`,
  );

  const { rows: existing } = await client.query<{ file: string }>(
    `select file from ${APPLIED_TABLE}`,
  );
  if (existing.length > 0) return new Set(existing.map((r) => r.file));

  const { rows: hasUsers } = await client.query(
    `select 1 from information_schema.tables where table_schema = 'public' and table_name = 'users'`,
  );
  if (hasUsers.length === 0) return new Set();

  const preexisting = MIGRATION_FILES.slice(0, MIGRATION_FILES.indexOf("0005_open_vargas.sql"));
  for (const file of preexisting) {
    await client.query(`insert into ${APPLIED_TABLE} (file) values ($1)`, [file]);
  }
  return new Set(preexisting);
}

function splitStatements(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function applyMigrations(client: Client, files: string[]): Promise<void> {
  if (files.length === 0) return;
  await client.query("BEGIN");
  try {
    for (const file of files) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      for (const statement of splitStatements(sql)) {
        await client.query(statement);
      }
      await client.query(`insert into ${APPLIED_TABLE} (file) values ($1)`, [file]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

/**
 * Idempotent, concurrency-safe bootstrap: creates `moni_test` if it doesn't
 * exist and applies whichever of MIGRATION_FILES it hasn't seen yet. Safe to
 * call from test setup on every run — advisory locks serialize it across
 * vitest's parallel workers, and on an up-to-date database this costs one
 * cheap SELECT.
 *
 * Adding a migration means adding its filename to MIGRATION_FILES and nothing
 * else. (This used to guard on "does `users` exist", which meant an existing
 * moni_test silently skipped every migration after the first — the schema
 * drifted and DB tests failed with a confusing "column does not exist".)
 */
export async function ensureTestDatabase(): Promise<void> {
  await createDatabaseIfMissing();

  const client = new Client({ connectionString: TEST_SUPERUSER_DATABASE_URL });
  await client.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATE_LOCK_KEY]);
    try {
      const applied = await appliedMigrations(client);
      await applyMigrations(
        client,
        MIGRATION_FILES.filter((f) => !applied.has(f)),
      );
    } finally {
      await client.query("select pg_advisory_unlock($1)", [MIGRATE_LOCK_KEY]);
    }
  } finally {
    await client.end();
  }
}
