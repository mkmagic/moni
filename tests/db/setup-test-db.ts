// Bootstraps an ISOLATED `moni_test` database on the same local Postgres
// instance as the shared dev `moni` database (docker-compose.yml), and
// applies the two committed migrations to it directly via `pg`, bypassing
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
// applies both files in one transaction, exactly as
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
const MIGRATION_FILES = ["0000_nervous_master_mold.sql", "0001_rls_and_roles.sql"];

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

async function migrationsAlreadyApplied(client: Client): Promise<boolean> {
  const { rows } = await client.query(
    `select 1 from information_schema.tables where table_schema = 'public' and table_name = 'users'`,
  );
  return rows.length > 0;
}

function splitStatements(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function applyMigrations(client: Client): Promise<void> {
  await client.query("BEGIN");
  try {
    for (const file of MIGRATION_FILES) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      for (const statement of splitStatements(sql)) {
        await client.query(statement);
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

/**
 * Idempotent, concurrency-safe bootstrap: creates `moni_test` if it doesn't
 * exist and applies both committed migrations (schema + roles/RLS) if they
 * haven't run yet. Safe to call from test setup on every run — advisory
 * locks serialize it across vitest's parallel workers, and the "does
 * `users` exist" check makes re-invocation across test runs (and across
 * every subsequent test file within one run) a cheap no-op query.
 */
export async function ensureTestDatabase(): Promise<void> {
  await createDatabaseIfMissing();

  const client = new Client({ connectionString: TEST_SUPERUSER_DATABASE_URL });
  await client.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATE_LOCK_KEY]);
    try {
      if (!(await migrationsAlreadyApplied(client))) {
        await applyMigrations(client);
      }
    } finally {
      await client.query("select pg_advisory_unlock($1)", [MIGRATE_LOCK_KEY]);
    }
  } finally {
    await client.end();
  }
}
