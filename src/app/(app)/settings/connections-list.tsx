"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Landmark,
  CreditCard,
  Loader2,
  RefreshCw,
  RefreshCwOff,
  Pencil,
  TriangleAlert,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArmPrompt } from "@/components/arm-prompt";
import { ConnectionEditForm } from "@/components/connection-edit-form";
import { getConnectorDefinition } from "@/lib/connectors";
import { armCredentialWindow, startSyncRun, waitForSyncRun } from "@/lib/sync-client";
import { useSyncAll } from "@/lib/use-sync-all";
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

export function ConnectionsList({ initialConnections }: ConnectionsListProps) {
  const router = useRouter();
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});

  function setRow(id: string, state: RowState) {
    setRowStates((s) => ({ ...s, [id]: state }));
  }

  // The chain itself lives in useSyncAll (shared with the dashboard); this
  // page only maps its progress onto per-row states.
  const bulkSync = useSyncAll({
    onRunStarted: (id) => setRow(id, { kind: "syncing" }),
    onRunFinished: (id, status, error) =>
      setRow(
        id,
        // The run's own error, verbatim — swallowing it is what left "the
        // sync failed" with no way to tell a wrong password from an
        // unreachable bank.
        status === "succeeded"
          ? { kind: "idle" }
          : { kind: "error", message: error ?? "Sync failed" },
      ),
    onArmRejected: (id) => setRow(id, { kind: "error", message: "Wrong password" }),
    onChainFinished: () => router.refresh(),
  });
  const bulk = bulkSync.state;

  /** Single-row sync. Separate from the chain because a locked row shows its
   * own inline prompt rather than pausing a batch. */
  async function onSyncRow(id: string) {
    const started = await startSyncRun(id);
    if (started.kind === "locked") {
      setRow(id, { kind: "arming" });
      return;
    }
    if (started.kind === "error") {
      setRow(id, { kind: "error", message: started.message });
      return;
    }
    setRow(id, { kind: "syncing" });
    const run = await waitForSyncRun(started.syncRunId);
    setRow(
      id,
      run.status === "succeeded"
        ? { kind: "idle" }
        : { kind: "error", message: run.error ?? "Sync failed" },
    );
    router.refresh();
  }

  function onSyncAll() {
    bulkSync.start(initialConnections.map((c) => c.id));
  }

  async function onArmRow(id: string, password: string) {
    if (!(await armCredentialWindow(password))) {
      setRow(id, { kind: "error", message: "Wrong password" });
      return;
    }
    await onSyncRow(id);
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
          <ArmPrompt label="Unlock to continue" onArm={(p) => void bulkSync.arm(p)} />
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
