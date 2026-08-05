"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import type { ConnectionView } from "@/domain/connections";
import { getConnectorDefinition } from "@/lib/connectors";
import { waitForSyncRun } from "@/lib/sync-client";
import { syncErrorMessage } from "@/lib/sync-error-message";

/**
 * The one file-import surface, shared by the Investments screen, the
 * Long-term savings screen and the dashboard (#77 §4). It was the Investments
 * screen's private dialog until a second kind of file connection existed; a
 * parallel import path would have meant two dialogs drifting apart on the same
 * endpoint.
 *
 * It routes on the SELECTED connection's connector, not on where it was opened
 * from — the same picker can hold a Schwab CSV and a Harel PDF, and each needs
 * a different accepted file type and a different set of fields.
 */

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

interface ImportShape {
  title: string;
  description: string;
  /** A long-term-savings report is priced in shekels on the page; a broker CSV
   * has to say what to value its holdings in. */
  needsValuationCurrency: boolean;
  accept: string;
  fileLabel: string;
  submitLabel: string;
  busyDetail: string;
}

const STATEMENT: ImportShape = {
  title: "Import statement",
  description: "A CSV statement exported from your broker; the file stays bounded in memory.",
  needsValuationCurrency: true,
  accept: ".csv,text/csv",
  fileLabel: "Statement file",
  submitLabel: "Import statement",
  busyDetail: "Reading the file, valuing every holding, and refreshing exchange rates.",
};

const REPORT: ImportShape = {
  title: "Import report",
  description:
    "The provider's own quarterly report, as the PDF you downloaded. It is read in memory and never stored.",
  needsValuationCurrency: false,
  accept: ".pdf,application/pdf",
  fileLabel: "Report PDF",
  submitLabel: "Import report",
  busyDetail: "Reading the report and checking its figures against each other.",
};

function shapeFor(connection: ConnectionView | undefined): ImportShape {
  return getConnectorDefinition(connection?.connectorId ?? "")?.kind === "long_term_savings"
    ? REPORT
    : STATEMENT;
}

function connectionLabel(connection: ConnectionView): string {
  return (
    connection.displayName ??
    getConnectorDefinition(connection.connectorId)?.label ??
    connection.connectorId
  );
}

export function ImportDialog({
  open,
  onClose,
  connections,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  connections: ConnectionView[];
  onDone: (message: string) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [currency, setCurrency] = useState("USD");
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shape = shapeFor(connections.find((item) => item.id === connectionId));

  async function submit() {
    if (!file || !connectionId) {
      setError("Choose a file and its connection.");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError("The file is larger than 10 MiB.");
      return;
    }
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.append("file", file);
    if (shape.needsValuationCurrency) form.append("valuationCurrency", currency);
    try {
      const response = await fetch(`/api/connections/${connectionId}/sync`, {
        method: "POST",
        body: form,
      });
      if (!response.ok) {
        setError(
          ((await response.json().catch(() => ({}))) as { error?: string }).error ??
            "Could not import the file",
        );
        return;
      }
      const body = (await response.json()) as { syncRunId: string };
      // Parsing and promotion happen in a worker, so the run is only finished
      // once the poll says so — the dialog stays busy for all of it.
      const done = await waitForSyncRun(body.syncRunId);
      if (done.status !== "succeeded") {
        setError(`${syncErrorMessage(done.error)} The last accepted snapshot remains included.`);
        return;
      }
      onDone("Imported.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={busy ? () => undefined : onClose}
      title={shape.title}
      description={shape.description}
    >
      {busy ? (
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <p className="text-sm font-medium">Importing…</p>
          <p className="max-w-xs text-xs text-muted-foreground">{shape.busyDetail}</p>
        </div>
      ) : (
        <div className="space-y-4">
          <label className="block text-sm">
            Connection
            <select
              className="mt-1 w-full rounded-[var(--radius)] border border-border bg-background p-2"
              value={connectionId}
              onChange={(event) => {
                // A CSV chosen for a broker is not a PDF the parser can read,
                // so switching connector drops the file rather than posting it
                // to a worker that will reject it.
                setFile(null);
                setConnectionId(event.target.value);
              }}
            >
              {connections.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connectionLabel(connection)}
                </option>
              ))}
            </select>
          </label>
          {shape.needsValuationCurrency && (
            <label className="block text-sm">
              Valuation currency
              <input
                className="mt-1 w-full rounded-[var(--radius)] border border-border bg-background p-2 uppercase"
                value={currency}
                maxLength={3}
                onChange={(event) => setCurrency(event.target.value.toUpperCase())}
              />
            </label>
          )}
          <label className="block text-sm">
            {shape.fileLabel}
            <input
              aria-label={shape.fileLabel}
              type="file"
              accept={shape.accept}
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              className="mt-1 block w-full text-sm text-muted-foreground file:mr-3 file:cursor-pointer file:rounded-[var(--radius)] file:border file:border-border file:bg-muted file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground hover:file:bg-muted/70"
            />
          </label>
          {!connections.length && (
            <p className="text-xs text-muted-foreground">Create a file-import connection first.</p>
          )}
          {error && <p className="text-sm text-negative">{error}</p>}
          <Button disabled={!connections.length} onClick={() => void submit()}>
            {shape.submitLabel}
          </Button>
        </div>
      )}
    </Dialog>
  );
}
