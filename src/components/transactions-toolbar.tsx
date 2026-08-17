"use client";

import { useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, Search, SlidersHorizontal, X } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { PillButton } from "@/components/pill-button";
// From `lib`, never from `@/domain/transactions`: importing a runtime value
// out of the domain layer pulls `pg` into the client bundle.
import { SmartCategorizeButton } from "@/components/smart-categorize-button";
import { NO_CATEGORY } from "@/lib/transactions/filters";
import { SIZE_BANDS } from "@/lib/transactions/predicates";
import { TIMEFRAME_PRESETS, matchingTimeframe } from "@/lib/transactions/timeframes";
import { cn } from "@/lib/utils";
import type { CategoryView } from "@/domain/categorization";
import type { TableControls, ViewFilters } from "@/lib/transactions/table-view";

/** The filters that narrow the window in SQL, mirrored in the URL so the page
 * stays a deep-linkable server component. */
export interface ServerFilters {
  category: string;
  from: string;
  to: string;
}

/** Every URL-backed filter key this toolbar owns. Everything is set through
 * one atomic navigation, so a two-endpoint change (a timeframe preset) can
 * never lose one half to a stale snapshot. */
type UrlPatch = Partial<{
  category: string;
  from: string;
  to: string;
  direction: string;
  size: string;
  scope: string;
}>;

interface TransactionsToolbarProps {
  categories: CategoryView[];
  serverFilters: ServerFilters;
  viewFilters: ViewFilters;
  /** True when Income/Payment and size are filtered across the whole history
   * (server-side) rather than the loaded window (`scope=all`). */
  searchAll: boolean;
  /** Asia/Jerusalem "today", from the server — the timeframe presets derive
   * their ranges from it (never the browser clock). */
  today: string;
  controls: TableControls;
  onControlsChange: (next: TableControls) => void;
  smartCategorizeEnabled?: boolean;
  unplacedCount?: number;
}

// Only the <select> needs this: there is no Select primitive yet, and the
// text/date/amount fields all go through <Input>.
const selectClass =
  "w-full rounded-[var(--radius)] border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

export function TransactionsToolbar({
  categories,
  serverFilters,
  viewFilters,
  searchAll,
  today,
  controls,
  onControlsChange,
  smartCategorizeEnabled = false,
  unplacedCount = 0,
}: TransactionsToolbarProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const { from, to } = serverFilters;
  const { direction, size } = viewFilters;
  const activeTimeframe = matchingTimeframe(from, to, today);
  const customDates = (from !== "" || to !== "") && activeTimeframe === undefined;

  // Advanced Search opens itself when it holds an active value the default
  // sections can't show — otherwise a deep-linked custom range or a min/max set
  // and then collapsed would filter the table with no visible control saying so.
  const [advancedOpen, setAdvancedOpen] = useState(
    () => searchAll || customDates || controls.minAmount !== "" || controls.maxAmount !== "",
  );

  /** One navigation per change: clone the current params once, apply the patch,
   * push. An empty string deletes the key. */
  function setUrl(patch: UrlPatch) {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    startTransition(() => router.push(next.toString() ? `?${next}` : "/transactions"));
  }

  const set = <K extends keyof TableControls>(key: K, value: TableControls[K]) =>
    onControlsChange({ ...controls, [key]: value });

  const anyActive =
    serverFilters.category !== "" ||
    from !== "" ||
    to !== "" ||
    direction !== "all" ||
    size !== "all" ||
    searchAll ||
    controls.query !== "" ||
    controls.minAmount !== "" ||
    controls.maxAmount !== "";

  function clearAll() {
    onControlsChange({ ...controls, query: "", minAmount: "", maxAmount: "" });
    setUrl({ category: "", from: "", to: "", direction: "", size: "", scope: "" });
  }

  return (
    <Card className="flex flex-col gap-4 px-5 pb-4 pt-6" data-pending={pending ? "" : undefined}>
      {/* What to look for, then Smart Categorize — which drops to its own full
          width row on a phone rather than being crushed against the edge. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="w-full sm:max-w-sm sm:flex-1">
          <Field label="Search">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="text"
                value={controls.query}
                onChange={(e) => set("query", e.target.value)}
                placeholder="Search payee"
                className="pl-9"
              />
            </div>
          </Field>
        </div>
        {smartCategorizeEnabled && <SmartCategorizeButton count={unplacedCount} />}
      </div>

      {/* The simple sections: a tap picks a common answer, no typing. */}
      <div className="flex flex-col gap-3">
        <Section label="Timeframe">
          <PillButton
            selected={from === "" && to === ""}
            onClick={() => setUrl({ from: "", to: "" })}
          >
            {"All"}
          </PillButton>
          {TIMEFRAME_PRESETS.map((preset) => {
            const range = preset.range(today);
            return (
              <PillButton
                key={preset.key}
                selected={activeTimeframe === preset.key}
                onClick={() => setUrl({ from: range.from, to: range.to })}
              >
                {preset.label}
              </PillButton>
            );
          })}
        </Section>

        <Section label="Type">
          <PillButton selected={direction === "all"} onClick={() => setUrl({ direction: "" })}>
            {"All"}
          </PillButton>
          <PillButton
            selected={direction === "income"}
            onClick={() => setUrl({ direction: "income" })}
          >
            {"Income"}
          </PillButton>
          <PillButton
            selected={direction === "payment"}
            onClick={() => setUrl({ direction: "payment" })}
          >
            {"Payment"}
          </PillButton>
        </Section>

        <Section label="Size">
          <PillButton
            selected={size === "all"}
            onClick={() => setUrl({ size: "" })}
            title="Any amount"
          >
            {"All"}
          </PillButton>
          {SIZE_BANDS.map((band) => (
            <PillButton
              key={band.key}
              selected={size === band.key}
              onClick={() => setUrl({ size: band.key })}
              title={`${band.label} — ${band.hint}`}
            >
              {band.label}
            </PillButton>
          ))}
        </Section>

        <div className="w-full sm:w-64">
          <Field label="Category">
            <div className="relative">
              <select
                value={serverFilters.category}
                onChange={(e) => setUrl({ category: e.target.value })}
                className={`${selectClass} appearance-none pr-8`}
              >
                <option value="">{"All categories"}</option>
                <option value={NO_CATEGORY}>{"Uncategorized"}</option>
                {/* Indented with non-breaking spaces on purpose: one flat list
                    of 100+ entries with parents and children interleaved, and
                    an <option>'s leading plain whitespace is collapsed away. */}
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.parentId ? `  ${c.name}` : c.name}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            </div>
          </Field>
        </div>
      </div>

      {/* Advanced toggle + Clear */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          aria-expanded={advancedOpen}
          aria-controls="advanced-search"
          onClick={() => setAdvancedOpen((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-sm text-sm text-muted-foreground transition hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <SlidersHorizontal className="h-4 w-4" />
          {"Advanced Search"}
          <ChevronDown
            className={cn("h-4 w-4 transition-transform", advancedOpen && "rotate-180")}
          />
        </button>
        {anyActive && (
          <Button variant="ghost" onClick={clearAll} className="px-3">
            <X className="h-4 w-4" />
            {"Clear"}
          </Button>
        )}
      </div>

      {advancedOpen && (
        <div id="advanced-search" className="flex flex-col gap-4 border-t border-border pt-4">
          {/* The scope toggle: recent-only (fast) vs the whole history. */}
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-0.5">
              <span id="scope-label" className="text-sm font-medium text-foreground">
                {"Search the whole timeframe"}
              </span>
              <p className="max-w-md text-xs text-muted-foreground">
                {
                  "Off, Income/Payment and size cover the 100 most recent in your timeframe. On, they cover the whole timeframe — pair it with one to keep it quick."
                }
              </p>
            </div>
            <Switch
              checked={searchAll}
              onCheckedChange={(checked) => setUrl({ scope: checked ? "all" : "" })}
              aria-labelledby="scope-label"
            />
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="w-40">
              <Field label="From">
                <Input
                  type="date"
                  value={from}
                  onChange={(e) => setUrl({ from: e.target.value })}
                />
              </Field>
            </div>
            <div className="w-40">
              <Field label="To">
                <Input type="date" value={to} onChange={(e) => setUrl({ to: e.target.value })} />
              </Field>
            </div>

            {/* Amounts stay text + inputMode, never type="number": a number
                input hands back a coerced float, and money is an exact decimal
                string. These refine the loaded window. */}
            <div className="w-32">
              <Field label="Min amount">
                <Input
                  type="text"
                  inputMode="decimal"
                  value={controls.minAmount}
                  onChange={(e) => set("minAmount", e.target.value)}
                  placeholder="0"
                  className="tabular-nums"
                />
              </Field>
            </div>
            <div className="w-32">
              <Field label="Max amount">
                <Input
                  type="text"
                  inputMode="decimal"
                  value={controls.maxAmount}
                  onChange={(e) => set("maxAmount", e.target.value)}
                  placeholder="Any"
                  className="tabular-nums"
                />
              </Field>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
