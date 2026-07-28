/**
 * The browser side of the sync protocol, in one place: start a run, poll it
 * to a terminal state, arm the credential window. Three call sites now need
 * it — the connections list, the dashboard's Sync all, and the connect
 * wizard's first sync — and the 423-means-arm rule is too easy to get subtly
 * wrong in a second copy.
 */

/** Cadence for `waitForSyncRun`. The scrape takes tens of seconds at best. */
export const SYNC_POLL_MS = 2000;

export type StartSyncResult =
  | { kind: "started"; syncRunId: string }
  /** HTTP 423, and ONLY 423 — the credential window is closed, so the
   * remediation is "re-enter your Moni password", never "log in again". */
  | { kind: "locked" }
  | { kind: "error"; message: string };

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

/** Re-opens the credential window with the user's Moni password. */
export async function armCredentialWindow(password: string): Promise<boolean> {
  try {
    const res = await fetch("/api/connections/arm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
