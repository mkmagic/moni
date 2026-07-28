/**
 * Classifies a failed sync run so the connect wizard can offer the action
 * that might actually work — re-entering the bank login, or just retrying.
 *
 * The input is `sync_runs.error`, which `scripts/scrape-worker.mts` writes as
 * `"${errorType}: ${errorMessage}"` from israeli-bank-scrapers'
 * `ScraperErrorTypes`. Only the prefix is interpreted; the message is shown
 * to the user verbatim either way.
 */
export type SyncFailureKind =
  /** The stored bank login is the problem — retrying it unchanged cannot help. */
  | "credentials"
  /** The bank or the scrape misbehaved — the same credentials may well work. */
  | "transient"
  /** Not a prefix we know. Offer both actions rather than guess wrong. */
  | "unknown";

const CREDENTIAL_TYPES = new Set(["INVALID_PASSWORD", "CHANGE_PASSWORD", "ACCOUNT_BLOCKED"]);
const TRANSIENT_TYPES = new Set(["TIMEOUT", "GENERIC", "GENERAL_ERROR"]);

export function classifySyncFailure(error: string | null | undefined): SyncFailureKind {
  if (!error) return "unknown";
  const prefix = error.split(":", 1)[0].trim();
  if (CREDENTIAL_TYPES.has(prefix)) return "credentials";
  if (TRANSIENT_TYPES.has(prefix)) return "transient";
  // Includes TWO_FACTOR_RETRIEVER_MISSING, where neither action helps — the
  // user needs to see both and the verbatim message rather than be pointed
  // confidently at the wrong one.
  return "unknown";
}
