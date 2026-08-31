"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FileUp, RefreshCw, X, Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArmPrompt } from "@/components/arm-prompt";
import { ImportDialog } from "@/components/import-dialog";
import type { ConnectionView } from "@/domain/connections";
import { useSyncAll } from "@/lib/use-sync-all";

interface DashboardSyncProps {
  connectionIds: string[];
  /**
   * Every connection Moni cannot fetch on its own — a broker CSV and a pension
   * PDF alike. Deliberately not scoped to long-term savings: two file
   * connections behaving differently here would follow no rule a user could
   * infer, and Schwab gains the same discoverability (#77 §4).
   */
  importConnections: ConnectionView[];
  /** The user opted in and a fetchable connection's data has gone stale (#97). */
  showReminder: boolean;
  title: string;
  greeting: string;
}

/**
 * The dashboard's page heading plus its sync controls. They share one
 * `useSyncAll` chain deliberately: the reminder card and the always-visible
 * button are two entry points to the same sequential sync, and two hook
 * instances would let a user start two chains at once.
 *
 * The sync runs HERE now — the reminder card used to bounce the user to
 * Settings, which is the gap issue #4 named. Nothing about the security model
 * changed: each run still gets a 423 until the user's password re-opens the
 * credential window, so a stored bank login is never used without them.
 */
export function DashboardSync({
  connectionIds,
  importConnections,
  showReminder,
  title,
  greeting,
}: DashboardSyncProps) {
  const router = useRouter();
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const sync = useSyncAll({
    onRunFinished: (_id, status, runError) => {
      if (status === "failed") setError(runError ?? "A connection failed to sync");
    },
    onArmRejected: () => setError("Wrong password"),
    onChainFinished: () => router.refresh(),
  });

  function startAll() {
    setError(null);
    setDismissed(true);
    sync.start(connectionIds);
  }

  const progress = sync.state.kind === "running" ? sync.state : null;

  return (
    <>
      {showReminder && !dismissed && (
        <Card className="border-primary/40">
          <div className="flex items-center justify-between gap-4 px-5 py-4">
            <div>
              <p className="text-sm font-medium text-foreground">
                {"It's been a while since your last sync"}
              </p>
              <p className="text-xs text-muted-foreground">
                Refresh your connections to pull in any new transactions.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button type="button" onClick={startAll} className="gap-1.5">
                <RefreshCw className="h-3.5 w-3.5" /> Sync now
              </Button>
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => {
                  setDismissed(true);
                  // Clears the flag on the server session too, so it doesn't
                  // come back on the next navigation.
                  void fetch("/api/sync-prompt/dismiss", { method: "POST" }).catch(() => undefined);
                }}
                className="rounded-[var(--radius)] p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        </Card>
      )}

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
          <p className="text-sm text-muted-foreground">{greeting}</p>
        </div>
        <div data-tour="dash-sync" className="flex flex-col items-end gap-1.5">
          <div className="flex items-center gap-2">
            {/* Only offered when there is something to import — a dialog whose
                connection picker would be empty is a broken button. */}
            {importConnections.length > 0 && (
              <Button
                type="button"
                variant="outline"
                onClick={() => setImportOpen(true)}
                className="gap-1.5"
              >
                <FileUp className="h-3.5 w-3.5" /> Import file
              </Button>
            )}
            {sync.state.kind === "locked" ? (
              <ArmPrompt label="Unlock to continue" onArm={() => sync.arm()} />
            ) : (
              // Outline, not the amber primary: the dashboard's accent belongs
              // to the reminder card's own call to action when it's showing.
              <Button
                type="button"
                variant="outline"
                onClick={startAll}
                disabled={progress !== null || connectionIds.length === 0}
                className="gap-1.5"
              >
                {progress ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                {progress ? `Syncing ${progress.done + 1} of ${progress.total}…` : "Sync all"}
              </Button>
            )}
          </div>
          {error && <span className="max-w-xs break-words text-xs text-negative">{error}</span>}
        </div>
      </div>

      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        connections={importConnections}
        onDone={() => {
          setImportOpen(false);
          router.refresh();
        }}
      />
    </>
  );
}
