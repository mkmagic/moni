"use client";

import Link from "next/link";
import { ArrowLeft, Check, Copy, Download, FileUp } from "lucide-react";
import { useState } from "react";

import { Money } from "@/components/money";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type {
  OpeningLotImportPreview,
  OpeningLotImportResult,
} from "@/domain/investment-opening-lots";
import type { OpeningLotImportRow } from "@/lib/investments/opening-lots-csv";

interface ValidatedFile {
  preview: OpeningLotImportPreview;
  rows: OpeningLotImportRow[];
}

export function OpeningLotImportScreen({ prompt, columns }: { prompt: string; columns: string[] }) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [file, setFile] = useState<File | null>(null);
  const [validated, setValidated] = useState<ValidatedFile | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const header = columns.join(",");

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
    } catch {
      setError("Clipboard access was blocked. The prompt remains selectable below.");
    }
  }

  function downloadTemplate() {
    const blob = new Blob([`${header}\n`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "moni-opening-lots-template.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function validateFile() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("file", file);
      const response = await fetch("/api/investments/activity/opening-lots/preview", {
        method: "POST",
        body: form,
      });
      const payload = (await response.json().catch(() => ({}))) as ValidatedFile & {
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error ?? "The CSV could not be validated.");
      setValidated(payload);
      setStep(3);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The CSV could not be validated.");
    } finally {
      setBusy(false);
    }
  }

  async function importLots() {
    if (!validated) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/investments/activity/opening-lots/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rows: validated.rows }),
      });
      const payload = (await response.json().catch(() => ({}))) as OpeningLotImportResult & {
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error ?? "The opening lots could not be imported.");
      window.location.assign(`/investments/activity?imported=${payload.inserted}#opening-lots`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The opening lots could not be imported.");
      setBusy(false);
    }
  }

  const groups = validated
    ? [
        ...new Set(
          validated.preview.rows.map(
            (row) => `${row.account}\u0000${row.isin ?? `${row.symbol}@${row.exchange}`}`,
          ),
        ),
      ].map((key) => {
        const [account, identity] = key.split("\u0000");
        return {
          key,
          account,
          identity,
          rows: validated.preview.rows.filter(
            (row) =>
              row.account === account && (row.isin ?? `${row.symbol}@${row.exchange}`) === identity,
          ),
        };
      })
    : [];

  return (
    <div className="mx-auto w-full max-w-6xl">
      <Link
        href="/investments/activity"
        className="mb-4 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Activity & lots
      </Link>
      <Card className="space-y-6 p-6 pt-7">
        <div>
          <h2 className="text-xl font-semibold">Import opening lots</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            One synchronous review flow. Nothing is written before the final import.
          </p>
        </div>
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Step {step} of 3 ·{" "}
          {step === 1 ? "Prepare your CSV" : step === 2 ? "Upload & validate" : "Review & import"}
        </p>

        {step === 1 && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
                This optional prompt helps an AI tool of your choice format a broker or spreadsheet
                export. It runs outside Moni and grants no AI write access. Review the resulting CSV
                before uploading it here.
              </p>
              <Button onClick={() => void copyPrompt()}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {copied ? "Copied" : "Copy prompt"}
              </Button>
            </div>
            <pre className="max-h-72 select-text overflow-auto whitespace-pre-wrap rounded-[var(--radius)] border border-border bg-background p-4 font-mono text-xs leading-5 text-muted-foreground">
              {prompt}
            </pre>
            <div className="rounded-[var(--radius)] border border-border p-4">
              <p className="text-sm font-medium">Canonical CSV template</p>
              <code className="mt-2 block overflow-x-auto whitespace-nowrap font-mono text-xs text-muted-foreground">
                {header}
              </code>
              <Button variant="outline" className="mt-3" onClick={downloadTemplate}>
                <Download className="h-4 w-4" /> Download template
              </Button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <div>
              <label htmlFor="opening-lots-csv" className="text-sm font-medium">
                Opening-lot CSV
              </label>
              <input
                id="opening-lots-csv"
                type="file"
                accept=".csv,text/csv"
                onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null);
                  setError(null);
                }}
                className="mt-2 block w-full rounded-[var(--radius)] border border-input bg-background p-2 text-sm text-muted-foreground file:mr-3 file:rounded-[var(--radius)] file:border file:border-border file:bg-muted file:px-3 file:py-1.5 file:text-foreground"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Maximum 10 MB. Validation is synchronous and reports the source row when a value is
              missing or invalid.
            </p>
          </div>
        )}

        {step === 3 && validated && (
          <div className="space-y-5">
            <div className="flex flex-wrap gap-2">
              <Badge className="border-positive/30 text-positive tabular-nums">
                {validated.preview.ready} ready
              </Badge>
              {validated.preview.skipped > 0 && (
                <Badge className="tabular-nums">
                  {validated.preview.skipped} duplicates skipped
                </Badge>
              )}
              {validated.preview.unresolvedFx > 0 && (
                <Badge className="border-primary/40 text-primary tabular-nums">
                  {validated.preview.unresolvedFx} FX incomplete
                </Badge>
              )}
            </div>
            {groups.map((group) => (
              <section key={group.key}>
                <h3 className="border-b border-border bg-muted/40 px-3 py-2 text-sm font-medium">
                  {group.account} · {group.identity}
                </h3>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1120px] border-separate border-spacing-0 text-xs">
                    <thead className="text-left text-muted-foreground">
                      <tr>
                        <th className="border-b border-border px-3 py-2">Trade date</th>
                        <th className="border-b border-border px-3 py-2 text-right">
                          Original / remaining
                        </th>
                        <th className="border-b border-border px-3 py-2 text-right">
                          Unit / total cost
                        </th>
                        <th className="border-b border-border px-3 py-2">Currency / fee</th>
                        <th className="border-b border-border px-3 py-2">
                          ILS FX rate / provenance
                        </th>
                        <th className="border-b border-border px-3 py-2">Completeness</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.rows.map((row, index) => (
                        <tr key={`${row.tradeDate}:${row.brokerLotId ?? index}`}>
                          <td className="border-b border-border/60 px-3 py-3 tabular-nums">
                            {row.tradeDate}
                          </td>
                          <td className="border-b border-border/60 px-3 py-3 text-right tabular-nums">
                            {row.quantity} / {row.remainingQuantity}
                          </td>
                          <td className="border-b border-border/60 px-3 py-3 text-right">
                            <span className="tabular-nums">{row.unitCost ?? "—"}</span>
                            {" / "}
                            <Money value={{ amount: row.totalCost, currency: row.currency }} />
                          </td>
                          <td className="border-b border-border/60 px-3 py-3">
                            {row.currency} ·{" "}
                            {row.fee ? (
                              <Money value={{ amount: row.fee, currency: row.currency }} />
                            ) : (
                              "no fee"
                            )}
                          </td>
                          <td className="border-b border-border/60 px-3 py-3 tabular-nums">
                            {row.lockedFxRate ?? "Not available"} ·{" "}
                            {row.lockedFxProvenance.replaceAll("_", " ")}
                          </td>
                          <td className="border-b border-border/60 px-3 py-3">
                            <Badge
                              className={
                                row.lockedFxProvenance === "unresolved"
                                  ? "border-primary/40 text-primary"
                                  : "border-positive/30 text-positive"
                              }
                            >
                              {row.status === "skipped_duplicate"
                                ? "Duplicate"
                                : row.lockedFxProvenance === "unresolved"
                                  ? "Partial"
                                  : "Complete"}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ))}
            <p className="text-xs text-muted-foreground">
              Import writes the reviewed rows, derives the affected lots, then re-checks each latest
              broker snapshot in this request. Moni reports remaining gaps from that read-back.
            </p>
          </div>
        )}

        {error && <p className="text-sm text-negative">{error}</p>}
        <div className="flex items-center justify-between border-t border-border pt-4">
          {step === 1 ? (
            <Link
              href="/investments/activity"
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              Back to activity
            </Link>
          ) : (
            <Button variant="ghost" onClick={() => setStep(step === 3 ? 2 : 1)} disabled={busy}>
              Back
            </Button>
          )}
          {step === 1 ? (
            <Button variant="outline" onClick={() => setStep(2)}>
              Continue to upload
            </Button>
          ) : step === 2 ? (
            <Button onClick={() => void validateFile()} disabled={!file || busy}>
              <FileUp className="h-4 w-4" /> Upload & validate
            </Button>
          ) : (
            <Button onClick={() => void importLots()} disabled={!validated?.preview.ready || busy}>
              Import {validated?.preview.ready ?? 0} opening lots
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}
