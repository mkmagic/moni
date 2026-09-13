"use client";

import Decimal from "decimal.js";
import Link from "next/link";
import { ArrowLeft, CheckCircle2, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { Money } from "@/components/money";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type {
  DisposalResolutionPreview,
  InvestmentResolutionItemView,
} from "@/domain/investment-activity-resolution";

async function post<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? "The resolution could not be saved.");
  }
  return response.json() as Promise<T>;
}

function Evidence({ item }: { item: InvestmentResolutionItemView }) {
  return (
    <div className="grid gap-3 text-sm sm:grid-cols-2">
      <div>
        <p className="text-xs text-muted-foreground">Account</p>
        <p className="mt-1">{item.accountName}</p>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">Investment</p>
        <p className="mt-1">{item.instrumentLabel}</p>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">Event or source date</p>
        <p className="mt-1 tabular-nums">{item.eventDateLabel ?? "Not retained"}</p>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">Affected figures</p>
        <p className="mt-1">{item.affectedMetrics.join(", ")}</p>
      </div>
    </div>
  );
}

function AuditView({ item }: { item: InvestmentResolutionItemView }) {
  return (
    <>
      <div className="flex items-center gap-2 text-positive">
        <CheckCircle2 className="h-4 w-4" />
        <span className="text-sm font-medium">Resolved {item.resolvedAtLabel ?? "recently"}</span>
      </div>
      <Evidence item={item} />
      {item.sale && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[620px] border-separate border-spacing-0 text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="border-b border-border pb-2">Acquired</th>
                <th className="border-b border-border pb-2 text-right">Quantity closed</th>
                <th className="border-b border-border pb-2 text-right">Realized cost basis</th>
                <th className="border-b border-border pb-2 text-right">Proceeds</th>
              </tr>
            </thead>
            <tbody>
              {item.sale.resolvedAllocations.map((allocation) => (
                <tr key={allocation.lotId}>
                  <td className="border-b border-border/60 py-3 tabular-nums">
                    {allocation.acquisitionDate ?? "—"}
                  </td>
                  <td className="border-b border-border/60 py-3 text-right tabular-nums">
                    {allocation.quantity}
                  </td>
                  <td className="border-b border-border/60 py-3 text-right">
                    {allocation.nativeRealizedCostBasis ? (
                      <Money
                        value={{
                          amount: allocation.nativeRealizedCostBasis,
                          currency: item.sale!.currency,
                        }}
                      />
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="border-b border-border/60 py-3 text-right">
                    {allocation.nativeProceeds ? (
                      <Money
                        value={{ amount: allocation.nativeProceeds, currency: item.sale!.currency }}
                      />
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        This is a permanent audit record. Resolved items cannot be edited or reopened.
      </p>
    </>
  );
}

function IdentityEvidence({ item }: { item: InvestmentResolutionItemView }) {
  const identity = item.identity!;
  return (
    <>
      <Evidence item={item} />
      <div className="grid gap-4 rounded-[var(--radius)] border border-border p-4 text-sm sm:grid-cols-2">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Retained source evidence
          </p>
          <p className="mt-2">{identity.source}</p>
          <p className="mt-1 text-muted-foreground">
            <bdi>{identity.description ?? "No description retained"}</bdi>
          </p>
          {identity.amount && identity.currency && (
            <p className="mt-2">
              <Money value={{ amount: identity.amount, currency: identity.currency }} />
            </p>
          )}
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Durable identifiers
          </p>
          {identity.durableIdentifiers.length ? (
            identity.durableIdentifiers.map((identifier) => (
              <p key={`${identifier.label}:${identifier.value}`} className="mt-2">
                <span className="text-muted-foreground">{identifier.label}</span>
                <br />
                <span className="font-mono">{identifier.value}</span>
              </p>
            ))
          ) : (
            <p className="mt-2 text-muted-foreground">No durable identifier was retained.</p>
          )}
        </div>
      </div>
      <div className="flex gap-2 rounded-[var(--radius)] border border-primary/30 p-4 text-sm text-muted-foreground">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div>
          <p>{identity.limitation}</p>
          <p className="mt-2">No choice or commit action is available for this item.</p>
        </div>
      </div>
    </>
  );
}

function SaleWizard({ item }: { item: InvestmentResolutionItemView }) {
  const sale = item.sale!;
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [values, setValues] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<DisposalResolutionPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  let allocated = new Decimal(0);
  let valid = true;
  for (const value of Object.values(values)) {
    if (!value.trim()) continue;
    try {
      const quantity = new Decimal(value);
      if (!quantity.isPositive()) valid = false;
      allocated = allocated.plus(quantity);
    } catch {
      valid = false;
    }
  }
  const exact = valid && allocated.equals(sale.quantity);
  const allocations = sale.eligibleLots.flatMap((lot) =>
    values[lot.id]?.trim() ? [{ lotId: lot.id, quantity: values[lot.id].trim() }] : [],
  );

  async function review() {
    setBusy(true);
    setError(null);
    try {
      setPreview(
        await post<DisposalResolutionPreview>(
          `/api/investments/activity/resolutions/${item.id}/preview`,
          { allocations },
        ),
      );
      setStep(3);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The allocation could not be reviewed.");
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/investments/activity/resolutions/${item.id}`, { allocations });
      window.location.assign(`/investments/activity?resolved=${encodeURIComponent(item.id)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The allocation could not be saved.");
      setBusy(false);
    }
  }

  return (
    <>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Step {step} of 3 · {step === 1 ? "Understand" : step === 2 ? "Choose" : "Review"}
      </p>
      {step === 1 && (
        <>
          <Evidence item={item} />
          <div className="grid gap-3 rounded-[var(--radius)] border border-border p-4 text-sm sm:grid-cols-3">
            <div>
              <p className="text-xs text-muted-foreground">Quantity sold</p>
              <p className="mt-1 tabular-nums">
                {sale.quantity} {sale.quantityUnit}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Native proceeds</p>
              <p className="mt-1">
                <Money value={{ amount: sale.proceeds, currency: sale.currency }} />
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Source</p>
              <p className="mt-1">{sale.source}</p>
            </div>
          </div>
          <p className="text-sm text-muted-foreground">{item.consequence}</p>
        </>
      )}
      {step === 2 && (
        <>
          {sale.eligibleLots.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[840px] border-separate border-spacing-0 text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="border-b border-border pb-2">Acquired</th>
                    <th className="border-b border-border pb-2 text-right">Remaining qty</th>
                    <th className="border-b border-border pb-2 text-right">Native cost basis</th>
                    <th className="border-b border-border pb-2">Locked ILS FX</th>
                    <th className="border-b border-border pb-2">Completeness</th>
                    <th className="border-b border-border pb-2 text-right">Quantity to close</th>
                  </tr>
                </thead>
                <tbody>
                  {sale.eligibleLots.map((lot) => (
                    <tr key={lot.id}>
                      <td className="border-b border-border/60 py-3 tabular-nums">
                        {lot.acquisitionDate}
                      </td>
                      <td className="border-b border-border/60 py-3 text-right tabular-nums">
                        {lot.remainingQuantity}
                      </td>
                      <td className="border-b border-border/60 py-3 text-right">
                        <Money value={{ amount: lot.nativeCostBasis, currency: lot.currency }} />
                      </td>
                      <td className="border-b border-border/60 py-3 text-xs">
                        {lot.lockedFxState}
                        <br />
                        <span className="text-muted-foreground tabular-nums">
                          {lot.lockedFxRate ?? "No rate"} · {lot.lockedFxDate ?? "No date"}
                        </span>
                      </td>
                      <td className="border-b border-border/60 py-3">
                        <Badge
                          className={
                            lot.completeness === "complete"
                              ? "border-positive/30 text-positive"
                              : "border-primary/40 text-primary"
                          }
                        >
                          {lot.completeness}
                        </Badge>
                      </td>
                      <td className="border-b border-border/60 py-3 pl-4">
                        <Input
                          aria-label={`Quantity from lot acquired ${lot.acquisitionDate}`}
                          inputMode="decimal"
                          value={values[lot.id] ?? ""}
                          onChange={(event) =>
                            setValues((held) => ({ ...held, [lot.id]: event.target.value }))
                          }
                          className="ml-auto max-w-36 text-right tabular-nums"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="rounded-[var(--radius)] border border-primary/30 p-4 text-sm text-muted-foreground">
              No eligible lots exist yet. Add an opening lot for {item.instrumentLabel}, then return
              to allocate this sale.
              <div className="mt-3">
                <Link
                  href={`/investments/activity/opening-lots/add?accountId=${item.accountId}&instrumentId=${item.instrumentId ?? ""}`}
                  className="font-medium text-primary hover:underline"
                >
                  Add one opening lot
                </Link>
              </div>
            </div>
          )}
          <div className="flex items-center justify-between rounded-[var(--radius)] border border-border px-4 py-3 text-sm">
            <span>Allocated / sold</span>
            <span className={exact ? "text-positive tabular-nums" : "text-primary tabular-nums"}>
              {allocated.toString()} / {sale.quantity}
            </span>
          </div>
        </>
      )}
      {step === 3 && preview && (
        <>
          <div className="grid gap-4 rounded-[var(--radius)] border border-border p-4 text-sm sm:grid-cols-3">
            <div>
              <p className="text-xs text-muted-foreground">Native proceeds</p>
              <Money value={{ amount: preview.nativeProceeds, currency: preview.currency }} />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Realized cost basis</p>
              <Money
                value={{ amount: preview.nativeRealizedCostBasis, currency: preview.currency }}
              />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">ILS gain · includes FX</p>
              {preview.ilsGainIncludesFx ? (
                <Money value={{ amount: preview.ilsGainIncludesFx, currency: "ILS" }} signColor />
              ) : (
                <span className="text-muted-foreground">Not available · FX incomplete</span>
              )}
            </div>
          </div>
          <div className="space-y-2 text-sm">
            {preview.allocations.map((allocation) => (
              <div
                key={allocation.lotId}
                className="flex items-center justify-between gap-4 border-b border-border/60 pb-2"
              >
                <span className="tabular-nums">Acquired {allocation.acquisitionDate}</span>
                <span className="tabular-nums">Close {allocation.quantity}</span>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Confirming creates permanent lot closures and a permanent audit record. It cannot be
            edited or reopened.
          </p>
        </>
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
          <Button onClick={() => setStep(2)}>Choose lots</Button>
        ) : step === 2 ? (
          <Button onClick={() => void review()} disabled={!exact || busy}>
            Review allocation
          </Button>
        ) : (
          <Button onClick={() => void commit()} disabled={!exact || busy}>
            Confirm lot allocation
          </Button>
        )}
      </div>
    </>
  );
}

export function ResolutionScreen({ item }: { item: InvestmentResolutionItemView }) {
  return (
    <div className="mx-auto w-full max-w-4xl">
      <Link
        href="/investments/activity"
        className="mb-4 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Activity & lots
      </Link>
      <Card className="space-y-6 p-6 pt-7">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">
              {item.kindLabel}: {item.instrumentLabel}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{item.accountName}</p>
          </div>
          <Badge
            className={
              item.status === "resolved"
                ? "border-positive/30 text-positive"
                : "border-primary/40 text-primary"
            }
          >
            {item.status === "resolved" ? "Resolved" : "Pending"}
          </Badge>
        </div>
        {item.status === "resolved" ? (
          <AuditView item={item} />
        ) : item.kind === "unresolved_disposal" && item.sale ? (
          <SaleWizard item={item} />
        ) : item.kind === "identity_ambiguity" && item.identity ? (
          <IdentityEvidence item={item} />
        ) : item.kind === "reconciliation_gap" && item.gap ? (
          <>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Step 1 of 3 · Understand
            </p>
            <Evidence item={item} />
            <div className="grid gap-3 rounded-[var(--radius)] border border-border p-4 text-sm sm:grid-cols-3">
              <div>
                <p className="text-xs text-muted-foreground">Evidence</p>
                <p className="mt-1 capitalize">{item.gap.dimensionLabel}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Broker snapshot</p>
                <p className="mt-1 tabular-nums">{item.gap.expected ?? "Not available"}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Activity-derived</p>
                <p className="mt-1 tabular-nums">{item.gap.observed ?? "Not available"}</p>
              </div>
            </div>
            {item.gap.canAddOpeningLot ? (
              <div className="flex justify-end border-t border-border pt-4">
                <Link
                  href={`/investments/activity/opening-lots/add?queueId=${item.id}`}
                  className="inline-flex items-center justify-center rounded-[var(--radius)] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
                >
                  Add the missing opening lot
                </Link>
              </div>
            ) : (
              <div className="rounded-[var(--radius)] border border-border p-4 text-sm text-muted-foreground">
                This gap needs source evidence Moni cannot create. Re-import a corrected broker
                statement; no in-app write action is available for this dimension.
              </div>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">The retained evidence is incomplete.</p>
        )}
      </Card>
    </div>
  );
}
