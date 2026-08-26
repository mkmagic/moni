// Decides whether a connection's data is stale enough for the dashboard to
// flag it as "out of date" in the insight panel.
//
// The threshold depends on how the connection refreshes. A credentialed fetch
// is expected to be re-run often, so a week without one is worth a nudge. An
// import source only ever refreshes when the user uploads a new file — a
// pension statement arrives quarterly, a broker export whenever the user
// bothers — so measuring it against the same week-long window would keep it
// permanently flagged. It gets a full quarter before it counts as stale.
//
// A pure function so the rule is unit-tested without rendering the dashboard.

/** A credentialed connection is nagged about once its last fetch is this old. */
export const STALE_FETCH_DAYS = 7;
/** An import source is nagged about only after this long with no upload. */
export const STALE_IMPORT_DAYS = 90;

const DAY_MS = 86_400_000;

export interface ConnectionStaleness {
  mode: "credentialed_fetch" | "user_mediated_import";
  /** Last successful sync/upload, or `null` if it has never happened. */
  lastSyncAt: Date | null;
  /** Injectable for tests; defaults to now. */
  now?: number;
}

/**
 * True when `lastSyncAt` is older than the connection's mode-specific window,
 * or the connection has never synced at all. Import sources get the longer
 * `STALE_IMPORT_DAYS` window; everything else gets `STALE_FETCH_DAYS`.
 */
export function isConnectionStale({
  mode,
  lastSyncAt,
  now = Date.now(),
}: ConnectionStaleness): boolean {
  if (lastSyncAt == null) return true;
  const threshold = mode === "user_mediated_import" ? STALE_IMPORT_DAYS : STALE_FETCH_DAYS;
  return Math.floor((now - lastSyncAt.getTime()) / DAY_MS) >= threshold;
}
