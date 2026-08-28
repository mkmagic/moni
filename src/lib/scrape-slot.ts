// The box-wide bank-scrape slot (issue #82). A bank scrape peaks ~1.3–1.6 GB
// RSS (#54, the israeli-bank-scrapers Chrome child), and two at once do not fit
// on the 4 GB deployed host (#47) — including two started by DIFFERENT users.
//
// The guard is a single cluster-global Postgres advisory lock, deliberately NOT
// a `sync_runs` read: every user-owned table is FORCE-RLS'd, so `moni_app`
// cannot see another tenant's `running` row at all (an unset `app.user_id`
// yields zero rows, by design). Advisory locks live outside RLS and carry no
// row data, so this serializes scrapes across every tenant while reading — and
// leaking — nothing. It is held on a dedicated connection for the scrape's
// memory-heavy phase and, being session-scoped, auto-releases if the server
// process dies, so a crash can never wedge the slot.
//
// Only the bank scrape takes the slot: IBKR/SnapTrade fetches and file imports
// are light (bounded HTTP/API responses, ≤10 MB uploads) and never risk OOM.
import { checkoutClient } from "@/db/client";

/** A stable, collision-resistant key for the one global scrape slot. `hashtext`
 * maps it to the int4 pair `pg_try_advisory_lock(int4, int4)` takes. */
const SLOT_KEY = "moni:bank-scrape-slot";

export interface ScrapeSlot {
  /** Releases the advisory lock and returns the connection to the pool.
   * Idempotent — safe to call from more than one terminal path. Fire-and-forget
   * for callers (bank-sync's exit handlers ignore the result); the returned
   * promise resolves once the slot is actually free, which tests await. */
  release(): Promise<void>;
}

/**
 * Tries to take the box-wide bank-scrape slot. Resolves to a handle when the
 * slot was free, or `null` when a scrape is already running (the caller then
 * refuses the sync with "sync already in progress"). Never blocks: it uses the
 * non-waiting `pg_try_advisory_lock`.
 */
export async function acquireScrapeSlot(): Promise<ScrapeSlot | null> {
  const client = await checkoutClient();
  let locked = false;
  try {
    const res = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock(hashtext($1), 0) as locked",
      [SLOT_KEY],
    );
    locked = res.rows[0]?.locked ?? false;
  } catch (error) {
    client.release();
    throw error;
  }
  if (!locked) {
    client.release();
    return null;
  }

  let released: Promise<void> | null = null;
  return {
    release() {
      // Best-effort unlock; even if it fails, releasing the connection drops
      // the session that holds the lock, so Postgres frees it either way.
      released ??= client
        .query("select pg_advisory_unlock(hashtext($1), 0)", [SLOT_KEY])
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => client.release());
      return released;
    },
  };
}
