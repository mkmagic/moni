"use client";

import Link from "next/link";
import { CheckCircle2, ChevronRight, FileUp, Plus, TriangleAlert } from "lucide-react";
import { Fragment, useState } from "react";

import { Money } from "@/components/money";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import type {
  InvestmentActivityView,
  InvestmentResolutionKind,
} from "@/domain/investment-activity-resolution";
import { cn } from "@/lib/utils";

const FILTERS: Array<{ kind: InvestmentResolutionKind; label: string }> = [
  { kind: "unresolved_disposal", label: "Sales" },
  { kind: "identity_ambiguity", label: "Identity" },
  { kind: "reconciliation_gap", label: "History gaps" },
];
const linkButton =
  "inline-flex items-center justify-center gap-2 rounded-[var(--radius)] border border-border px-4 py-2 text-sm font-medium text-foreground transition hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring";

function Completeness({ value }: { value: "complete" | "partial" | "unknown" }) {
  return (
    <Badge
      className={
        value === "complete"
          ? "border-positive/30 text-positive"
          : value === "partial"
            ? "border-primary/40 text-primary"
            : "text-muted-foreground"
      }
    >
      {value === "unknown" ? "Not available" : value[0].toUpperCase() + value.slice(1)}
    </Badge>
  );
}

export function ActivityScreen({
  view,
  notice,
  highlightedResolutionId,
  highlightedAccountIds,
}: {
  view: InvestmentActivityView;
  notice: string | null;
  highlightedResolutionId: string | null;
  highlightedAccountIds: string[];
}) {
  const [filter, setFilter] = useState<InvestmentResolutionKind | null>(null);
  const visible = filter ? view.pending.filter((item) => item.kind === filter) : view.pending;
  const groups = [...new Set(visible.map((item) => item.accountId))].map((accountId) => ({
    accountId,
    accountName: visible.find((item) => item.accountId === accountId)!.accountName,
    items: visible.filter((item) => item.accountId === accountId),
  }));
  const multipleLotAccounts = new Set(view.lots.map((lot) => lot.accountId)).size > 1;
  const hasOpeningLots = view.openingLots.some((account) => account.lotCount > 0);
  return (
    <div className="flex flex-col gap-6">
      <div data-tour="investments-activity">
        <h2 className="text-xl font-semibold">Activity & lots</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Review incomplete investment evidence and manage the lots that predate Moni.
        </p>
      </div>

      {notice && (
        <div className="flex items-start gap-2 rounded-[var(--radius)] border border-positive/30 px-4 py-3 text-sm text-positive">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p>{notice}</p>
            {highlightedAccountIds.length > 0 && (
              <p className="mt-1 flex flex-wrap gap-x-3 text-xs">
                {view.openingLots
                  .filter((account) => highlightedAccountIds.includes(account.accountId))
                  .map((account) => (
                    <a
                      key={account.accountId}
                      href={`#opening-lots-${account.accountId}`}
                      className="underline underline-offset-2"
                    >
                      View {account.accountName}
                    </a>
                  ))}
              </p>
            )}
          </div>
        </div>
      )}

      {view.pendingCount > 0 && (
        <Card className="pt-6">
          <div className="flex flex-wrap items-start justify-between gap-4 px-6">
            <div>
              <h3 className="font-semibold">Needs review</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                These items make one or more performance figures partial.
              </p>
            </div>
            <Badge className="border-primary/40 text-primary tabular-nums">
              {view.pendingCount} items
            </Badge>
          </div>
          <div className="mt-5 flex flex-wrap gap-4 border-y border-border px-6 py-3">
            {FILTERS.map((item) => {
              const count =
                item.kind === "unresolved_disposal"
                  ? view.counts.sales
                  : item.kind === "identity_ambiguity"
                    ? view.counts.identity
                    : view.counts.historyGaps;
              const active = filter === item.kind;
              return (
                <button
                  key={item.kind}
                  type="button"
                  onClick={() => setFilter(active ? null : item.kind)}
                  className={cn(
                    "text-sm transition hover:text-foreground",
                    active ? "font-medium text-primary" : "text-muted-foreground",
                  )}
                >
                  {item.label} <span className="tabular-nums">{count}</span>
                </button>
              );
            })}
          </div>
          <div className="divide-y divide-border">
            {groups.length ? (
              groups.map((group) => (
                <section key={group.accountId}>
                  <h4 className="bg-muted/40 px-6 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {group.accountName}
                  </h4>
                  <div className="divide-y divide-border/60">
                    {group.items.map((item) => (
                      <Link
                        key={item.id}
                        href={`/investments/activity/resolve/${item.id}`}
                        className="flex items-center justify-between gap-4 px-6 py-4 transition hover:bg-muted/40 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-ring"
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{item.instrumentLabel}</span>
                            <Badge>{item.kindLabel}</Badge>
                            <Badge className="border-primary/40 text-primary">Pending</Badge>
                          </div>
                          <p className="mt-1 text-sm text-muted-foreground">{item.consequence}</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {item.eventDateLabel ?? "Account history"} · affects{" "}
                            {item.affectedMetrics.join(", ")}
                          </p>
                        </div>
                        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                      </Link>
                    ))}
                  </div>
                </section>
              ))
            ) : (
              <p className="px-6 py-5 text-sm text-muted-foreground">
                No pending items match this filter.
              </p>
            )}
          </div>
        </Card>
      )}

      {view.lots.length > 0 && (
        <Card data-tour="investments-lots" className="p-6 pt-7">
          <h3 className="font-semibold">Lots</h3>
          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[620px] border-separate border-spacing-0 text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="border-b border-border pb-3">Date</th>
                  <th className="border-b border-border pb-3">Stock</th>
                  <th className="border-b border-border pb-3 text-right">Shares</th>
                  <th className="border-b border-border pb-3 text-right">Price</th>
                  <th className="border-b border-border pb-3 text-right">Price (ILS)</th>
                  <th className="border-b border-border pb-3 text-right">Total</th>
                  <th className="border-b border-border pb-3 text-right">Total (ILS)</th>
                </tr>
              </thead>
              <tbody>
                {view.lots.map((lot, index) => (
                  <Fragment key={lot.id}>
                    {multipleLotAccounts && lot.accountId !== view.lots[index - 1]?.accountId && (
                      <tr>
                        <td
                          colSpan={7}
                          className="border-b border-border/60 pb-2 pt-4 text-xs font-medium uppercase tracking-wide text-muted-foreground"
                        >
                          {lot.accountName}
                        </td>
                      </tr>
                    )}
                    <tr>
                      <td className="border-b border-border/60 py-3 tabular-nums text-muted-foreground">
                        {lot.acquisitionDateLabel}
                      </td>
                      <td className="border-b border-border/60 py-3 font-medium">
                        {lot.instrumentLabel}
                      </td>
                      <td className="border-b border-border/60 py-3 text-right tabular-nums">
                        {lot.quantity}
                        {lot.remainingQuantity !== lot.quantity && (
                          <span className="text-muted-foreground">
                            {` · ${lot.remainingQuantity} left`}
                          </span>
                        )}
                      </td>
                      <td className="border-b border-border/60 py-3 text-right">
                        <Money value={{ amount: lot.pricePerShare, currency: lot.currency }} />
                      </td>
                      <td className="border-b border-border/60 py-3 text-right">
                        {lot.pricePerShareIls ? (
                          <Money value={{ amount: lot.pricePerShareIls, currency: "ILS" }} />
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="border-b border-border/60 py-3 text-right">
                        <Money value={{ amount: lot.totalCost, currency: lot.currency }} />
                      </td>
                      <td className="border-b border-border/60 py-3 text-right">
                        {lot.totalCostIls ? (
                          <Money value={{ amount: lot.totalCostIls, currency: "ILS" }} />
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card id="opening-lots" data-tour="investments-opening-lots" className="p-6 pt-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h3 className="font-semibold">Opening lots</h3>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Record investments you owned before Moni had trustworthy activity history.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href="/investments/activity/opening-lots/add" className={linkButton}>
              <Plus className="h-4 w-4" /> Add one lot
            </Link>
            <Link href="/investments/activity/opening-lots/import" className={linkButton}>
              <FileUp className="h-4 w-4" /> Import CSV
            </Link>
          </div>
        </div>
        {hasOpeningLots && (
          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[620px] border-separate border-spacing-0 text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="border-b border-border pb-3">Account</th>
                  <th className="border-b border-border pb-3 text-right">Opening lots</th>
                  <th className="border-b border-border pb-3 text-right">Cost-basis coverage</th>
                  <th className="border-b border-border pb-3 text-right">Last import</th>
                </tr>
              </thead>
              <tbody>
                {view.openingLots.map((account) => (
                  <tr
                    key={account.accountId}
                    id={`opening-lots-${account.accountId}`}
                    className={cn(
                      highlightedAccountIds.includes(account.accountId) &&
                        "outline outline-1 outline-positive/40",
                    )}
                  >
                    <td className="border-b border-border/60 py-3 font-medium">
                      {account.accountName}
                    </td>
                    <td className="border-b border-border/60 py-3 text-right tabular-nums">
                      {account.lotCount}
                    </td>
                    <td className="border-b border-border/60 py-3 text-right">
                      <Completeness value={account.completeness} />
                    </td>
                    <td className="border-b border-border/60 py-3 text-right text-muted-foreground tabular-nums">
                      {account.lastImportLabel ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {view.recentlyResolved.length > 0 && (
        <details open={Boolean(highlightedResolutionId)}>
          <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">
            Recently resolved · <span className="tabular-nums">{view.recentlyResolved.length}</span>
          </summary>
          <Card className="mt-3 divide-y divide-border/60">
            {view.recentlyResolved.map((item) => (
              <div
                key={item.id}
                className={cn(
                  "flex flex-wrap items-center justify-between gap-3 px-5 py-4",
                  highlightedResolutionId === item.id && "border-l-2 border-l-positive",
                )}
              >
                <div>
                  <p className="text-sm font-medium">
                    {item.instrumentLabel} · {item.kindLabel}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {item.accountName} · resolved {item.resolvedAtLabel ?? "recently"}
                  </p>
                </div>
                <Link
                  href={`/investments/activity/resolve/${item.id}`}
                  className="text-sm text-muted-foreground hover:text-foreground hover:underline"
                >
                  View resolution
                </Link>
              </div>
            ))}
          </Card>
        </details>
      )}

      {view.pending.some((item) => item.kind === "identity_ambiguity") && (
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Identity items are currently
          evidence-only; their conflicting candidate was not retained by the ingestion seam.
        </p>
      )}
    </div>
  );
}
