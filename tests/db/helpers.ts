// Shared test-only helpers for tests/db/**: an elevated (Postgres
// superuser) connection to moni_test for fixture setup/teardown and
// system-catalog queries, plus a generic cross-tenant fixture cleanup
// routine. Nothing here is a production code path — see
// docs/design/domain-layer.md §5 for why fixtures need a superuser
// connection at all (moni_owner is also FORCE-RLS'd).
import { randomBytes } from "node:crypto";
import { Client, Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@/db/schema";
import {
  UNLOCK_SECRET_LENGTH,
  enrollCredentialUnlockMethod,
  unlockCredentialKey,
} from "@/domain/credential-unlock";
import { TEST_APP_DATABASE_URL, TEST_SUPERUSER_DATABASE_URL } from "./setup-test-db";

export { TEST_APP_DATABASE_URL, TEST_SUPERUSER_DATABASE_URL };

/**
 * Gives `userId` a credential key by enrolling a second factor with a random
 * 32-byte unlock secret, and returns CK for the test to encrypt with.
 *
 * This is the PRODUCTION enrollment path (src/domain/credential-unlock.ts) —
 * the only thing missing is the WebAuthn ceremony that would normally
 * produce those bytes in a browser, which is a route-edge concern the domain
 * layer deliberately knows nothing about (issue #7). There is no test-only
 * branch in the domain layer that could leak into a deployment; a random
 * secret here is indistinguishable from a real PRF output, because that is
 * exactly what the seam was designed to accept.
 *
 * A user created by `createUser()` has NO credential key until this runs —
 * the login password cannot mint or open one. Any test that touches bank
 * credentials needs this call.
 */
export async function enrollTestCredentialKey(userId: string): Promise<Buffer> {
  const secret = randomBytes(UNLOCK_SECRET_LENGTH);
  const { methodId } = await enrollCredentialUnlockMethod(
    userId,
    secret,
    {
      credentialIdB64Url: randomBytes(16).toString("base64url"),
      publicKeyB64Url: randomBytes(64).toString("base64url"),
      counter: 0,
      transports: ["internal"],
      rpId: "localhost",
      label: "Test passkey",
    },
    null,
  );
  // Read CK back through the real unlock path rather than keeping the copy
  // enrollment returned — the fixture then also proves the row it just wrote
  // is genuinely openable.
  const credentialKey = await unlockCredentialKey(userId, methodId, secret);
  if (!credentialKey) throw new Error("test setup: enrolled method did not unlock");
  return credentialKey;
}

/**
 * Elevated (superuser) pool for moni_test. Used only for:
 *  - seeding fixture rows across multiple different owners before an
 *    isolation test (something no RLS-subject role, including moni_owner,
 *    can do in one step);
 *  - structural/system-catalog assertions (information_schema, pg_policies,
 *    pg_class.relforcerowsecurity);
 *  - cross-tenant fixture cleanup.
 * Never used to exercise the app's actual access pattern — use `withUser()`
 * from src/db/client.ts for that.
 */
export const elevatedPool = new Pool({ connectionString: TEST_SUPERUSER_DATABASE_URL });
export const elevatedDb = drizzle(elevatedPool, { schema });

/** A fresh, unconnected superuser `Client` to moni_test, for tests that need
 * to control a single dedicated physical connection/session (e.g. the
 * GUC-placeholder-reuse case in rls-isolation.test.ts). Caller owns
 * connect()/end(). */
export function newSuperuserClient(): Client {
  return new Client({ connectionString: TEST_SUPERUSER_DATABASE_URL });
}

/** A fresh, unconnected `moni_app`-role `Client` to moni_test, for tests
 * that need to control a single dedicated physical connection/session
 * directly (bypassing the pooled `withUser()` helper, which cannot
 * guarantee the same underlying connection is reused across calls). Caller
 * owns connect()/end(). */
export function newAppRoleClient(): Client {
  return new Client({ connectionString: TEST_APP_DATABASE_URL });
}

/**
 * Every RLS-protected (owner_id-scoped) table, in child-before-parent
 * delete order so a bulk cleanup never trips a foreign-key violation. This
 * is also exactly the table set structural tests assert RLS is enabled on
 * (25 tables; `fx_rates` is the sole non-RLS exception — data-model.md §2).
 */
export const OWNER_SCOPED_TABLES_DELETE_ORDER = [
  "investment_market_quotes",
  "investment_snapshot_cash_balances",
  "investment_snapshot_positions",
  "investment_source_evidence",
  "investment_snapshot_details",
  "instrument_source_mappings",
  "instruments",
  "merchant_lookups",
  "budget_ceilings",
  "budget_incomes",
  "category_rejections",
  "entry_field_changelog",
  "entry_transactions",
  "sync_staging",
  "transfers",
  "entries",
  "rule_conditions",
  "rule_actions",
  "rules",
  "long_term_savings_snapshot_deposits",
  "long_term_savings_snapshot_tracks",
  "long_term_savings_snapshots",
  "long_term_savings_details",
  "credit_card_details",
  "account_balance_snapshots",
  "accounts",
  "sync_runs",
  "connections",
  "merchants",
  "categories",
  "user_unlock_methods",
  "agent_access_log",
  "mcp_oauth_auth_codes",
  "mcp_oauth_grants",
  "agent_tokens",
  "users",
] as const;

/**
 * Deletes every row owned by any of `ownerIds` across all owner-scoped
 * tables, in FK-safe order, via the elevated (RLS-bypassing) pool. Test
 * files call this in `afterAll`/`afterEach` so fixture rows never leak
 * between runs or between other test files.
 */
export async function cleanupOwners(ownerIds: string[]): Promise<void> {
  if (ownerIds.length === 0) return;
  const client = await elevatedPool.connect();
  try {
    await client.query("BEGIN");
    for (const table of OWNER_SCOPED_TABLES_DELETE_ORDER) {
      // `users` is the root of the ownership graph — it's keyed by `id`, not
      // `owner_id` (every other table here has an `owner_id` FK back to it).
      const column = table === "users" ? "id" : "owner_id";
      await client.query(`DELETE FROM "${table}" WHERE ${column} = ANY($1::uuid[])`, [ownerIds]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Deletes fx_rates fixture rows by id (fx_rates has no owner_id — it's
 * global reference data, data-model.md §5). */
export async function cleanupFxRates(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await elevatedPool.query(`DELETE FROM "fx_rates" WHERE id = ANY($1::uuid[])`, [ids]);
}
