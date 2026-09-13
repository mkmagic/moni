"use client";

import Decimal from "decimal.js";
import { useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Money } from "@/components/money";
import { cn } from "@/lib/utils";
import type {
  InvestmentInstrumentReturns,
  InvestmentMetricQuality,
  InvestmentMoneyFigure,
  InvestmentRateFigure,
} from "@/domain/investment-returns";
import type { PerformanceAccount, PerformanceView } from "./types";

const BASIS_LABEL: Record<string, string> = {
  ils_gain_includes_fx: "ILS gain · includes FX",
  native_price_gain: "Native price gain",
  booked_cash_income: "Booked cash income",
  time_weighted_return_ils: "Time-weighted return · ILS",
  money_weighted_return_ils_irr: "Money-weighted return · ILS · IRR",
};

const PORTFOLIO = "__portfolio__";

function percent(rate: string): string {
  return `${new Decimal(rate).mul(100).toDecimalPlaces(2).toFixed()}%`;
}
function rateSign(rate: string): "text-positive" | "text-negative" | undefined {
  const value = new Decimal(rate);
  if (value.isZero()) return undefined;
  return value.isNegative() ? "text-negative" : "text-positive";
}
/** A full ISO timestamp or a plain date; a pure string slice keeps it identical
 * on server and client (no Date parsing, no locale — the hydration trap). */
function dayOf(value: string | null): string | null {
  return value ? value.slice(0, 10) : null;
}

async function fetchView(accountId: string | null): Promise<PerformanceView> {
  const query = accountId ? `?accountId=${encodeURIComponent(accountId)}` : "";
  const response = await fetch(`/api/investments/performance${query}`);
  if (!response.ok)
    throw new Error(
      ((await response.json().catch(() => ({}))) as { error?: string }).error ??
        "Could not load performance",
    );
  return response.json() as Promise<PerformanceView>;
}

function CompletenessPill({ quality }: { quality: InvestmentMetricQuality }) {
  if (quality.completeness === "complete")
    return <Badge className="border-positive/30 text-positive">Complete</Badge>;
  if (quality.completeness === "partial")
    return <Badge className="border-primary/40 text-primary">Partial</Badge>;
  return <Badge className="border-border text-muted-foreground">Not available</Badge>;
}

/** Provenance + valuation/FX dates, collapsed behind a native <details> so it
 * needs no client state and never triggers a browser dialog. */
function MetricDetails({ quality }: { quality: InvestmentMetricQuality }) {
  const valuation = dayOf(quality.valuationAsOf);
  const fx = dayOf(quality.fxAsOf);
  return (
    <details className="mt-1 text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none hover:text-foreground">Details</summary>
      <div className="mt-1 space-y-0.5 border-l border-border pl-2">
        <p>
          Valuation as of <span className="tabular-nums text-foreground">{valuation ?? "—"}</span> ·
          FX as of <span className="tabular-nums text-foreground">{fx ?? "—"}</span>
        </p>
        {quality.provenance.length > 0 && <p>Sources: {quality.provenance.join(", ")}</p>}
      </div>
    </details>
  );
}

function NativeLine({ figures }: { figures: InvestmentMoneyFigure[] }) {
  if (!figures.length) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {figures.map((figure, index) => (
        <span key={figure.currency}>
          {index > 0 && " · "}
          <Money value={figure} className="text-muted-foreground" />
        </span>
      ))}
    </p>
  );
}

/** One money metric: the ILS amount (or "Not available" when unknown), its
 * basis line, native figures, a completeness pill, and a details disclosure. */
function MoneyMetric({
  label,
  figure,
  native,
  quality,
}: {
  label: string;
  figure: InvestmentMoneyFigure;
  native: InvestmentMoneyFigure[];
  quality: InvestmentMetricQuality;
}) {
  const unknown = quality.completeness === "unknown";
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-sm text-muted-foreground">{label}</span>
        <div className="flex items-center gap-2">
          {unknown ? (
            <span className="text-sm text-muted-foreground">Not available</span>
          ) : (
            <Money value={figure} signColor className="text-base font-semibold" />
          )}
          <CompletenessPill quality={quality} />
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="text-xs text-muted-foreground">{BASIS_LABEL[figure.basis]}</span>
        {quality.completeness === "partial" && !unknown && (
          <span className="text-xs text-primary">from known data</span>
        )}
      </div>
      {!unknown && <NativeLine figures={native} />}
      <MetricDetails quality={quality} />
    </div>
  );
}

/** One rate metric (TWR / MWR): a percentage, or "Not available" when the rate
 * could not be computed or the history is unknown. */
function RateMetric({
  label,
  figure,
  quality,
}: {
  label: string;
  figure: InvestmentRateFigure;
  quality: InvestmentMetricQuality;
}) {
  const unavailable = figure.rate === null || quality.completeness === "unknown";
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-sm text-muted-foreground">{label}</span>
        <div className="flex items-center gap-2">
          {unavailable ? (
            <span className="text-sm text-muted-foreground">Not available</span>
          ) : (
            <span className={cn("text-base font-semibold tabular-nums", rateSign(figure.rate!))}>
              {percent(figure.rate!)}
            </span>
          )}
          <CompletenessPill quality={quality} />
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="text-xs text-muted-foreground">{BASIS_LABEL[figure.basis]}</span>
        {quality.completeness === "partial" && !unavailable && (
          <span className="text-xs text-primary">from known data</span>
        )}
      </div>
      <MetricDetails quality={quality} />
    </div>
  );
}

/** One cell in the by-instrument table: ILS figure, native line, and pill. */
function InstrumentCell({
  figure,
  native,
  quality,
}: {
  figure: InvestmentMoneyFigure;
  native: InvestmentMoneyFigure[];
  quality: InvestmentMetricQuality;
}) {
  const unknown = quality.completeness === "unknown";
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-end gap-2">
        {unknown ? (
          <span className="text-sm text-muted-foreground">Not available</span>
        ) : (
          <Money value={figure} signColor className="tabular-nums" />
        )}
        <CompletenessPill quality={quality} />
      </div>
      {!unknown && (
        <div className="text-right">
          <NativeLine figures={native} />
        </div>
      )}
    </div>
  );
}

export function PerformanceScreen({
  initialView,
  accounts,
}: {
  initialView: PerformanceView;
  accounts: PerformanceAccount[];
}) {
  const [view, setView] = useState(initialView);
  const [selected, setSelected] = useState<string>(PORTFOLIO);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accountName = new Map(accounts.map((account) => [account.id, account.name]));

  async function choose(scope: string) {
    if (scope === selected) return;
    setSelected(scope);
    setBusy(true);
    setError(null);
    setExpanded(new Set());
    try {
      setView(await fetchView(scope === PORTFOLIO ? null : scope));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load performance");
    } finally {
      setBusy(false);
    }
  }

  const { summary, instruments } = view;
  const options = [{ id: PORTFOLIO, name: "Whole portfolio" }, ...accounts];

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        Gains, cash income, and two different return measures — each figure shows its basis and
        whether the underlying history is complete.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => void choose(option.id)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs transition",
              option.id === selected
                ? "border-primary/60 bg-primary/10 text-foreground"
                : "border-border bg-card text-muted-foreground hover:border-primary/50 hover:bg-muted",
            )}
          >
            {option.name}
          </button>
        ))}
        {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>

      {error && (
        <div className="rounded-[var(--radius)] border border-negative/40 px-4 py-3 text-sm text-negative">
          {error}
        </div>
      )}

      {/* The Gains / Returns / Cash-income summary grid — the tour anchor. */}
      <div data-tour="investments-performance" className="grid gap-4 lg:grid-cols-2">
        <Card className="space-y-4 p-5">
          <h2 className="text-sm font-medium text-muted-foreground">Gains</h2>
          <MoneyMetric
            label="Realized"
            figure={summary.realizedGain.ils}
            native={summary.realizedGain.native}
            quality={summary.realizedGain.quality}
          />
          <MoneyMetric
            label="Unrealized"
            figure={summary.unrealizedGain.ils}
            native={summary.unrealizedGain.native}
            quality={summary.unrealizedGain.quality}
          />
        </Card>

        <Card className="space-y-4 p-5">
          <h2 className="text-sm font-medium text-muted-foreground">Returns</h2>
          <RateMetric
            label="Time-weighted"
            figure={summary.performance.twr}
            quality={summary.performance.twr.quality}
          />
          <RateMetric
            label="Money-weighted (IRR)"
            figure={summary.performance.mwr}
            quality={summary.performance.mwr.quality}
          />
        </Card>

        <Card className="space-y-4 p-5 lg:col-span-2">
          <h2 className="text-sm font-medium text-muted-foreground">Cash income</h2>
          <MoneyMetric
            label="Dividends"
            figure={summary.dividendIncome.ils}
            native={summary.dividendIncome.native}
            quality={summary.dividendIncome.quality}
          />
          <p className="text-xs text-muted-foreground">
            {summary.dividendIncome.bookedCashCount} booked cash event
            {summary.dividendIncome.bookedCashCount === 1 ? "" : "s"}
          </p>
        </Card>
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">By instrument</h2>
        {instruments.length === 0 ? (
          <Card className="p-6 text-sm text-muted-foreground">
            No instrument-level history yet.
          </Card>
        ) : (
          <Card className="overflow-x-auto p-0">
            <table className="w-full min-w-[720px] border-separate border-spacing-0 text-sm">
              <thead className="text-left text-xs font-medium text-muted-foreground">
                <tr>
                  {[
                    ["Instrument", "left"],
                    ["Realized", "right"],
                    ["Unrealized", "right"],
                    ["Dividends", "right"],
                  ].map(([label, align]) => (
                    <th
                      key={label}
                      className={cn(
                        "whitespace-nowrap border-b border-border px-4 py-3",
                        align === "right" && "text-right",
                      )}
                    >
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {instruments.map((row) => {
                  const key = `${row.accountId}:${row.instrumentId}`;
                  const open = expanded.has(key);
                  return (
                    <InstrumentRows
                      key={key}
                      row={row}
                      open={open}
                      scope={view.scope}
                      accountName={accountName.get(row.accountId) ?? "Account"}
                      onToggle={() =>
                        setExpanded((prior) => {
                          const next = new Set(prior);
                          if (!next.delete(key)) next.add(key);
                          return next;
                        })
                      }
                    />
                  );
                })}
              </tbody>
            </table>
          </Card>
        )}
        <p className="text-xs text-muted-foreground">
          Time-weighted and money-weighted returns are measured at the account and portfolio level —
          the underlying value history isn&apos;t split per instrument, so they aren&apos;t shown in
          this table.
        </p>
      </section>
    </div>
  );
}

function InstrumentRows({
  row,
  open,
  scope,
  accountName,
  onToggle,
}: {
  row: InvestmentInstrumentReturns;
  open: boolean;
  scope: PerformanceView["scope"];
  accountName: string;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className="align-top">
        <td className="border-b border-border/60 px-4 py-3">
          <button
            type="button"
            aria-expanded={open}
            onClick={onToggle}
            className="flex items-center gap-2 text-left"
          >
            {open ? (
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            )}
            <span>
              <span className="font-medium">{row.label}</span>
              {row.name && row.name !== row.label && (
                <span className="block max-w-[220px] truncate text-xs text-muted-foreground">
                  {row.name}
                </span>
              )}
              {scope === "portfolio" && (
                <span className="block text-xs text-muted-foreground">{accountName}</span>
              )}
            </span>
          </button>
        </td>
        <td className="border-b border-border/60 px-4 py-3">
          <InstrumentCell
            figure={row.realizedGain.ils}
            native={row.realizedGain.native}
            quality={row.realizedGain.quality}
          />
        </td>
        <td className="border-b border-border/60 px-4 py-3">
          <InstrumentCell
            figure={row.unrealizedGain.ils}
            native={row.unrealizedGain.native}
            quality={row.unrealizedGain.quality}
          />
        </td>
        <td className="border-b border-border/60 px-4 py-3">
          <InstrumentCell
            figure={row.dividendIncome.ils}
            native={row.dividendIncome.native}
            quality={row.dividendIncome.quality}
          />
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={4} className="border-b border-border/60 bg-muted/30 px-4 py-3">
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <p className="text-xs font-medium text-muted-foreground">Realized</p>
                <MetricDetails quality={row.realizedGain.quality} />
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground">Unrealized</p>
                <MetricDetails quality={row.unrealizedGain.quality} />
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground">Dividends</p>
                <MetricDetails quality={row.dividendIncome.quality} />
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
