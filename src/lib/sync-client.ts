/**
 * The browser side of the sync protocol, in one place: start a run and poll
 * it to a terminal state. Three call sites need it — the connections list,
 * the dashboard's Sync all, and the connect wizard's first sync — and the
 * 423-means-arm rule is too easy to get subtly wrong in a second copy.
 *
 * Arming itself lives in src/lib/passkey-client.ts (`armWithPasskey`), since
 * issue #7 made it a WebAuthn ceremony rather than a password POST.
 */

/** Cadence for `waitForSyncRun`. The scrape takes tens of seconds at best. */
export const SYNC_POLL_MS = 2000;

export type StartSyncResult =
  | { kind: "started"; syncRunId: string }
  /** HTTP 423, and ONLY 423 — the credential window is closed, so the
   * remediation is "unlock with your passkey", never "log in again". */
  | { kind: "locked" }
  | { kind: "error"; message: string };

export type ConnectionSyncOutcome = StartSyncResult | { kind: "file_required" };

export async function startSyncRun(
  connectionId: string,
  startDate?: string,
): Promise<StartSyncResult> {
  try {
    const res = await fetch(`/api/connections/${connectionId}/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(startDate ? { startDate } : {}),
    });
    if (res.status === 423) return { kind: "locked" };
    if (res.status === 202) {
      const body = (await res.json()) as { syncRunId: string };
      return { kind: "started", syncRunId: body.syncRunId };
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { kind: "error", message: body.error ?? "Could not start sync" };
  } catch {
    return { kind: "error", message: "Could not reach the server" };
  }
}

/** Import sources need a user-selected file; they are not failed refreshes. */
export async function startConnectionSync(connection: {
  id: string;
  mode: "credentialed_fetch" | "user_mediated_import";
}): Promise<ConnectionSyncOutcome> {
  if (connection.mode === "user_mediated_import") return { kind: "file_required" };
  return startSyncRun(connection.id);
}

export type QuoteRefreshResult =
  /** The route answered 200 with refreshed:false — no Tiingo token configured. */
  | { kind: "not_configured" }
  | { kind: "refreshed"; attempted: number; updated: number }
  | { kind: "error" };

/**
 * Refreshes market-price estimates for every eligible holding.
 *
 * This lives here rather than on the Investments screen because it used to be
 * called from exactly one button there, which meant syncing from the dashboard
 * or Settings left quotes untouched and the portfolio silently valued on
 * yesterday's broker numbers.
 */
export async function refreshQuotes(): Promise<QuoteRefreshResult> {
  try {
    const res = await fetch("/api/investments/quotes/refresh", { method: "POST" });
    if (!res.ok) return { kind: "error" };
    const body = (await res.json()) as {
      refreshed?: boolean;
      attempted?: number;
      updated?: number;
    };
    if (!body.refreshed) return { kind: "not_configured" };
    return { kind: "refreshed", attempted: body.attempted ?? 0, updated: body.updated ?? 0 };
  } catch {
    return { kind: "error" };
  }
}

export interface FinishedRun {
  status: "succeeded" | "failed";
  error: string | null;
}

/** Polls one run to a terminal state. Resolves rather than rejecting on
 * failure, so a caller chaining several runs can decide what to do next. */
export function waitForSyncRun(syncRunId: string, pollMs = SYNC_POLL_MS): Promise<FinishedRun> {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      fetch(`/api/sync-runs/${syncRunId}`)
        .then((res) =>
          res.ok ? (res.json() as Promise<{ status: string; error: string | null }>) : null,
        )
        .then((run) => {
          if (!run) return;
          if (run.status === "succeeded" || run.status === "failed") {
            clearInterval(timer);
            resolve({ status: run.status, error: run.error });
          }
        })
        .catch(() => undefined);
    }, pollMs);
  });
}
