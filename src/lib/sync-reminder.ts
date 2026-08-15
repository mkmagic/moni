// Decides whether the dashboard offers to refresh the user's connections
// (issue #97).
//
// The offer is tied to how recently data was SYNCED, not to when the user last
// signed in: syncing has to make it disappear, and a login-time flag never
// did — it lingered until the next login however many times you synced. A
// pure function so the rule is unit-tested without a login round-trip.

/**
 * How stale a connection's data may be before an opted-in user is nudged to
 * refresh. This is its own freshness policy, deliberately NOT derived from the
 * session TTL: the offer is measured from the last sync, not the login, so
 * changing how long a login lasts is no reason to nag more or less often. The
 * two values happen to coincide at eight hours today; that is not a contract.
 */
export const SYNC_REMINDER_STALE_MS = 8 * 60 * 60 * 1000;

export interface SyncReminderInput {
  /** The user opted into the sync offer (`profile.autoSyncOnLogin`). */
  autoSyncOnLogin: boolean;
  /** The user dismissed the offer earlier this session. */
  dismissed: boolean;
  /**
   * `lastSyncAt` for every connection a sync can actually refresh — an active
   * credentialed fetch — one entry per connection, `null` for a never-synced
   * one. Disconnected/errored and import-only connections are excluded: the
   * offer must not stick on a source "Sync now" cannot pull.
   */
  syncableLastSyncAt: (Date | null)[];
  /** Injectable for tests; defaults to now. */
  now?: number;
}

/**
 * True when the offer should show. The dashboard is only as current as its
 * STALEST source (page.tsx), so a single never-synced or overdue connection is
 * enough — the user does have data waiting to be pulled.
 */
export function shouldPromptSync({
  autoSyncOnLogin,
  dismissed,
  syncableLastSyncAt,
  now = Date.now(),
}: SyncReminderInput): boolean {
  if (!autoSyncOnLogin || dismissed) return false;
  // Nothing Moni can refresh — no offer to refresh it.
  if (syncableLastSyncAt.length === 0) return false;
  return syncableLastSyncAt.some((d) => d === null || now - d.getTime() >= SYNC_REMINDER_STALE_MS);
}
