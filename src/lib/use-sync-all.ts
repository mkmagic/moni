"use client";

import { useRef, useState } from "react";
import { startSyncRun, waitForSyncRun } from "@/lib/sync-client";
import { armWithPasskey } from "@/lib/passkey-client";

/**
 * Bulk sync is SEQUENTIAL and driven from the client. Each scrape spawns its
 * own headless Chrome (~350MB), so running a family's connections in parallel
 * is the one thing most likely to exhaust a small self-hosted box — and banks
 * are not fond of concurrent logins either. Sequencing on the server would
 * need a queue/worker, i.e. pg-boss, which v1.0 explicitly defers; chaining
 * here reuses the existing 202-then-poll contract with no new server concept
 * and gives per-connection progress for free. The tradeoff, accepted: closing
 * the tab stops the chain. v1.0 syncs are user-triggered, so the user is
 * present by definition.
 *
 * Lives here rather than in the connections list because the dashboard runs
 * the same chain, and a second copy of the 423-means-arm rule would drift.
 */
export type SyncAllState =
  | { kind: "idle" }
  | { kind: "running"; done: number; total: number }
  /** Paused mid-chain on a 423 — resumes from `remaining` once armed. */
  | { kind: "locked"; remaining: string[]; done: number; total: number };

export interface SyncAllCallbacks {
  onRunStarted?: (connectionId: string) => void;
  onRunFinished?: (
    connectionId: string,
    status: "succeeded" | "failed",
    error: string | null,
  ) => void;
  /** Unlocking failed (cancelled, unenrolled device, RP ID mismatch); the
   * chain is abandoned at `connectionId`. `message` is showable verbatim. */
  onArmRejected?: (connectionId: string, message: string) => void;
  onChainFinished?: () => void;
}

export function useSyncAll(callbacks: SyncAllCallbacks = {}) {
  const [state, setState] = useState<SyncAllState>({ kind: "idle" });
  /** Re-entry guard, in a ref rather than state because it must be readable
   * and writable BETWEEN renders. The gap that needs it is `arm()`: it awaits
   * the network while the password prompt is still on screen and enabled, so
   * a double submit would otherwise start two chains over the same ids. */
  const busy = useRef(false);

  /** Runs `ids` one after another, pausing the moment one comes back locked.
   * A run that merely fails does not stop the chain — one dead bank shouldn't
   * block the rest. */
  async function runChain(ids: string[], alreadyDone: number, total: number) {
    busy.current = true;
    try {
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        setState({ kind: "running", done: alreadyDone + i, total });
        const started = await startSyncRun(id);
        if (started.kind === "locked") {
          setState({ kind: "locked", remaining: ids.slice(i), done: alreadyDone + i, total });
          return;
        }
        if (started.kind === "error") {
          callbacks.onRunFinished?.(id, "failed", started.message);
          continue;
        }
        callbacks.onRunStarted?.(id);
        const run = await waitForSyncRun(started.syncRunId);
        callbacks.onRunFinished?.(id, run.status, run.error);
      }
      setState({ kind: "idle" });
      callbacks.onChainFinished?.();
    } finally {
      // Also clears on the locked early-return: the chain is paused, waiting
      // on a password, and `arm` is what may resume it.
      busy.current = false;
    }
  }

  return {
    state,
    start(ids: string[]) {
      if (busy.current || ids.length === 0) return;
      void runChain(ids, 0, ids.length);
    },
    async arm() {
      if (busy.current || state.kind !== "locked") return;
      busy.current = true;
      const { remaining, done, total } = state;
      try {
        const armed = await armWithPasskey();
        if (!armed.ok) {
          setState({ kind: "idle" });
          callbacks.onArmRejected?.(remaining[0], armed.message);
          return;
        }
      } finally {
        busy.current = false;
      }
      // No await between the release above and runChain's own re-acquire, so
      // nothing can slip in between.
      void runChain(remaining, done, total);
    },
  };
}
