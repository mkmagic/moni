"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Landmark,
  CreditCard,
  Lock,
  Loader2,
  RefreshCw,
  RefreshCwOff,
  Pencil,
  TriangleAlert,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ConnectionEditForm } from "@/components/connection-edit-form";
import { getConnectorDefinition } from "@/lib/connectors";
import { cn } from "@/lib/utils";

interface ConnectionRowData {
  id: string;
  connectorId: string;
  displayName: string | null;
  status: string;
  /** Pre-formatted on the server — see the comment in connections/page.tsx.
   * Do NOT pass a raw date here and format it in this component; that is a
   * hydration mismatch (server locale/timezone vs the browser's). */
  lastSyncLabel: string;
  /** Last sync run for this connection ended in `failed`. */
  lastRunFailed: boolean;
  /** That run's `sync_runs.error`, shown verbatim — a scraper message like
   * "GENERIC: Navigation timeout of 30000 ms exceeded" is the only thing
   * that distinguishes a bad password from an unreachable bank. */
  lastRunError: string | null;
}

interface ConnectionsListProps {
  initialConnections: ConnectionRowData[];
}

type RowState =
  | { kind: "idle" }
  | { kind: "arming" }
  | { kind: "syncing" }
  | { kind: "editing" }
  | { kind: "error"; message: string };

/**
 * Sync outcome, shared by the single-row button and the Sync all chain.
 * "locked" is the 423 — and ONLY the 423, never 401/403 — which means "arm
 * the credential window", not "log in again".
 */
type SyncOutcome = "done" | "locked" | "failed";

/**
 * Bulk sync is SEQUENTIAL and driven from the client. Each scrape spawns its
 * own headless Chrome (~350MB), so running a family's connections in parallel
 * is the one thing most likely to exhaust a small self-hosted box — and banks
 * are not fond of concurrent logins either. Sequencing on the server would
 * need a queue/worker, i.e. pg-boss, which v1.0 explicitly defers; chaining
 * here reuses the existing 202-then-poll contract with no new server concept
 * and gives per-row progress for free. The tradeoff, accepted: closing the
 * tab stops the chain. v1.0 syncs are user-triggered, so the user is present
 * by definition.
 */
type BulkState =
  | { kind: "idle" }
  | { kind: "running"; done: number; total: number }
  | { kind: "locked"; remaining: string[]; done: number; total: number };

const POLL_MS = 2000;

export function ConnectionsList({ initialConnections }: ConnectionsListProps) {
  const router = useRouter();
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});
  const [bulk, setBulk] = useState<BulkState>({ kind: "idle" });

  function setRow(id: string, state: RowState) {
    setRowStates((s) => ({ ...s, [id]: state }));
  }

  /** Polls one run to a terminal state. Resolves rather than rejecting so a
   * chain can decide what to do next. */
  function waitForRun(id: string, syncRunId: string): Promise<SyncOutcome> {
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        fetch(`/api/sync-runs/${syncRunId}`)
          .then((res) =>
            res.ok ? (res.json() as Promise<{ status: string; error: string | null }>) : null,
          )
          .then((run) => {
            if (!run) return;
            if (run.status === "succeeded") {
              clearInterval(timer);
              setRow(id, { kind: "idle" });
              resolve("done");
              return;
            }
            if (run.status === "failed") {
              clearInterval(timer);
              // The run's own error, verbatim — swallowing it is what left
              // "the sync failed" with no way to tell a wrong password from
              // an unreachable bank.
              setRow(id, { kind: "error", message: run.error ?? "Sync failed" });
              resolve("failed");
            }
          })
          .catch(() => undefined);
      }, POLL_MS);
    });
  }

  /** Starts a sync and waits for it to finish. */
  async function syncOne(id: string): Promise<SyncOutcome> {
    try {
      const res = await fetch(`/api/connections/${id}/sync`, { method: "POST" });
      if (res.status === 423) return "locked";
      if (res.status === 202) {
        const body = (await res.json()) as { syncRunId: string };
        setRow(id, { kind: "syncing" });
        return await waitForRun(id, body.syncRunId);
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setRow(id, { kind: "error", message: body.error ?? "Could not start sync" });
      return "failed";
    } catch {
      setRow(id, { kind: "error", message: "Could not reach the server" });
      return "failed";
    }
  }

  async function onSyncRow(id: string) {
    const outcome = await syncOne(id);
    if (outcome === "locked") {
      setRow(id, { kind: "arming" });
      return;
    }
    router.refresh();
  }

  /** Runs `ids` one after another, pausing the moment one comes back locked. */
  async function runChain(ids: string[], alreadyDone: number, total: number) {
    for (let i = 0; i < ids.length; i++) {
      setBulk({ kind: "running", done: alreadyDone + i, total });
      const outcome = await syncOne(ids[i]);
      if (outcome === "locked") {
        setBulk({ kind: "locked", remaining: ids.slice(i), done: alreadyDone + i, total });
        return;
      }
    }
    setBulk({ kind: "idle" });
    router.refresh();
  }

  function onSyncAll() {
    const ids = initialConnections.map((c) => c.id);
    void runChain(ids, 0, ids.length);
  }

  async function arm(password: string): Promise<boolean> {
    const res = await fetch("/api/connections/arm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    return res.ok;
  }

  async function onArmRow(id: string, password: string) {
    if (!(await arm(password))) {
      setRow(id, { kind: "error", message: "Wrong password" });
      return;
    }
    await onSyncRow(id);
  }

  async function onArmBulk(password: string) {
    if (bulk.kind !== "locked") return;
    const { remaining, done, total } = bulk;
    if (!(await arm(password))) {
      setBulk({ kind: "idle" });
      setRow(remaining[0], { kind: "error", message: "Wrong password" });
      return;
    }
    void runChain(remaining, done, total);
  }

  if (initialConnections.length === 0) {
    return <p className="text-sm text-muted-foreground">No connections yet.</p>;
  }

  const bulkBusy = bulk.kind === "running";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-muted-foreground">
          {bulkBusy
            ? `Syncing ${bulk.done + 1} of ${bulk.total}…`
            : `${initialConnections.length} connected`}
        </p>
        {bulk.kind === "locked" ? (
          <ArmPrompt label="Unlock to continue" onArm={onArmBulk} />
        ) : (
          <Button
            type="button"
            variant="outline"
            onClick={onSyncAll}
            disabled={bulkBusy}
            className="gap-1.5 px-3 py-1.5 text-xs"
          >
            {bulkBusy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Sync all
          </Button>
        )}
      </div>

      {initialConnections.map((c) => {
        const def = getConnectorDefinition(c.connectorId);
        const Icon = def?.kind === "credit_card" ? CreditCard : Landmark;
        const state = rowStates[c.id] ?? { kind: "idle" };
        // A live error from this session wins; otherwise fall back to the
        // last persisted failure so a page reload doesn't erase it.
        const failureMessage =
          state.kind === "error"
            ? state.message
            : state.kind === "idle" && c.lastRunFailed
              ? (c.lastRunError ?? "Last sync failed")
              : null;
        return (
          <Card key={c.id}>
            <div className="flex items-center justify-between gap-4 px-6 py-5">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-[var(--radius)] bg-muted text-muted-foreground">
                  <Icon className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {c.displayName ?? def?.label ?? c.connectorId}
                  </p>
                  <p className="text-xs text-muted-foreground">{c.lastSyncLabel}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <StatusBadge status={c.status} />
                {state.kind === "syncing" ? (
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Syncing…
                  </span>
                ) : state.kind === "arming" ? (
                  <ArmPrompt label="Unlock" onArm={(p) => onArmRow(c.id, p)} />
                ) : (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() =>
                        setRow(
                          c.id,
                          state.kind === "editing" ? { kind: "idle" } : { kind: "editing" },
                        )
                      }
                      className="gap-1.5 px-3 py-1.5 text-xs"
                    >
                      <Pencil className="h-3.5 w-3.5" /> Edit
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void onSyncRow(c.id)}
                      disabled={bulkBusy}
                      className="gap-1.5 px-3 py-1.5 text-xs"
                    >
                      {bulkBusy ? (
                        <RefreshCwOff className="h-3.5 w-3.5" />
                      ) : (
                        <RefreshCw className="h-3.5 w-3.5" />
                      )}
                      Sync
                    </Button>
                  </>
                )}
              </div>
            </div>

            {state.kind === "editing" && (
              <ConnectionEditForm
                connectionId={c.id}
                connectorId={c.connectorId}
                displayName={c.displayName}
                onCancel={() => setRow(c.id, { kind: "idle" })}
                onSaved={() => {
                  setRow(c.id, { kind: "idle" });
                  router.refresh();
                }}
              />
            )}

            {failureMessage && (
              <div className="flex gap-2.5 border-t border-negative/30 bg-negative/10 px-6 py-4">
                <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0 text-negative" />
                <div className="min-w-0">
                  <p className="text-xs font-medium text-negative">Last sync failed</p>
                  <p className="break-words text-xs text-muted-foreground">{failureMessage}</p>
                </div>
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge
      className={cn(
        status === "active" && "border-positive/40 text-positive",
        status === "error" && "border-negative/40 text-negative",
      )}
    >
      {status}
    </Badge>
  );
}

function ArmPrompt({ label, onArm }: { label: string; onArm: (password: string) => void }) {
  const [password, setPassword] = useState("");
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const p = password;
        setPassword("");
        onArm(p);
      }}
    >
      <Lock className="h-3.5 w-3.5 text-muted-foreground" />
      <Input
        type="password"
        autoComplete="current-password"
        placeholder="Password"
        className="w-32"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      <Button type="submit" variant="outline" className="whitespace-nowrap px-2 py-1 text-xs">
        {label}
      </Button>
    </form>
  );
}
