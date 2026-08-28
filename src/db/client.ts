import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { assertDatabaseTls } from "@/lib/transport";

/**
 * Host-agnostic connection pool. `DATABASE_URL` is the app-runtime
 * connection — it authenticates as the RLS-subject `moni_app` role (see
 * .env.example). Works unmodified against local Docker Postgres or a
 * managed provider; `sslmode` is controlled entirely by the URL — which is
 * why the URL is checked here before anything connects.
 */
assertDatabaseTls(process.env.DATABASE_URL);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export const db = drizzle(pool, { schema });

/**
 * Checks out a raw pooled client, for the rare caller that needs a single
 * connection held across several statements OUTSIDE a `withUser` transaction —
 * currently only the box-wide bank-scrape slot (src/lib/scrape-slot.ts), which
 * holds a session-level advisory lock for a scrape's lifetime. The caller MUST
 * `release()` the returned client. This is not an access path to user data:
 * RLS still applies (no `app.user_id` is set here), so a query for a
 * user-owned row would return zero rows — it exists only for connection-scoped
 * primitives like advisory locks that are independent of RLS.
 */
export function checkoutClient(): Promise<import("pg").PoolClient> {
  return pool.connect();
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The scoped transaction `withUser()` hands its callback. Exported so a
 * domain helper that runs *inside* someone else's `withUser` can name its
 * parameter (e.g. `unwrapDataKey` in src/domain/auth.ts) instead of spelling
 * out a nested `Parameters<…>` chain.
 */
export type UserTransaction = Transaction;

/**
 * The single scoping primitive the domain/service layer is built on
 * (docs/security/security-design-principles.md §9). Every user-owned table
 * is RLS-protected with a policy keyed on `current_setting('app.user_id')`,
 * and it is this function's job — not each query's — to set that value.
 *
 * We use `select set_config('app.user_id', $1, true)` rather than
 * `SET LOCAL app.user_id = $1` because `SET` cannot be parameterized; the
 * `true` (local) argument scopes the setting to this transaction only, so it
 * is cleared automatically at commit/rollback and never leaks across a
 * pooled connection to a different user's request.
 *
 * This is the *only* place `app.user_id` should be set. Callers get a
 * transaction already scoped to `userId` and run their reads/writes on it.
 */
export async function withUser<T>(userId: string, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}
