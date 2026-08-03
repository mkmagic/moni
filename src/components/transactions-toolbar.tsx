"use client";

import { useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, Search, X } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
// From `lib`, never from `@/domain/transactions`: importing a runtime value
// out of the domain layer pulls `pg` into the client bundle.
import { SmartCategorizeButton } from "@/components/smart-categorize-button";
import { NO_CATEGORY } from "@/lib/transactions/filters";
import type { CategoryView } from "@/domain/categorization";
import type { TableControls } from "@/lib/transactions/table-view";

/** The filters that narrow the window in SQL, mirrored in the URL so the page
 * stays a deep-linkable server component. */
export interface ServerFilters {
  category: string;
  from: string;
  to: string;
}

interface TransactionsToolbarProps {
  categories: CategoryView[];
  serverFilters: ServerFilters;
  controls: TableControls;
  onControlsChange: (next: TableControls) => void;
  smartCategorizeEnabled?: boolean;
  unplacedCount?: number;
}

// Only the <select> needs this: there is no Select primitive yet, and the
// text/date/amount fields all go through <Input>. Kept in sync with
// `ui/input.tsx` by eye — if a Select primitive lands, this goes.
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

export function TransactionsToolbar({
  categories,
  serverFilters,
  controls,
  onControlsChange,
  smartCategorizeEnabled = false,
  unplacedCount = 0,
}: TransactionsToolbarProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  /** Category and dates live in the URL, so changing one is a navigation and
   * a fresh server read — not local state. */
  function setServerFilter(key: keyof ServerFilters, value: string) {
    const next = new URLSearchParams(searchParams.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    startTransition(() => router.push(next.toString() ? `?${next}` : "/transactions"));
  }

  const set = <K extends keyof TableControls>(key: K, value: TableControls[K]) =>
    onControlsChange({ ...controls, [key]: value });

  const anyActive =
    serverFilters.category !== "" ||
    serverFilters.from !== "" ||
    serverFilters.to !== "" ||
    controls.query !== "" ||
    controls.minAmount !== "" ||
    controls.maxAmount !== "";

  function clearAll() {
    onControlsChange({ ...controls, query: "", minAmount: "", maxAmount: "" });
    // Clears this toolbar's own keys rather than the whole query string, so
    // anything else the URL is carrying survives — same contract as
    // `setServerFilter`.
    const next = new URLSearchParams(searchParams.toString());
    for (const key of ["category", "from", "to"]) next.delete(key);
    startTransition(() => router.push(next.toString() ? `?${next}` : "/transactions"));
  }

  return (
    <Card className="flex flex-col gap-3 px-5 pb-4 pt-6" data-pending={pending ? "" : undefined}>
      {/* Two deliberate rows — what to look for, then how far to look. Six
          controls on one line orphans the last one onto a row of its own at
          anything under a very wide viewport. */}
      <div className="flex flex-wrap items-end gap-3">
        {/* Capped: a search input stretched across a full-width card reads as
            an empty void, the same measure problem as a long helper line. */}
        <div className="min-w-[16rem] max-w-sm flex-1">
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

        <div className="w-48">
          <Field label="Category">
            <div className="relative">
              <select
                value={serverFilters.category}
                onChange={(e) => setServerFilter("category", e.target.value)}
                className={`${selectClass} appearance-none pr-8`}
              >
                <option value="">All categories</option>
                <option value={NO_CATEGORY}>Uncategorized</option>
                {/* Indented with non-breaking spaces on purpose: this is one
                    flat list of 100+ entries with parents and children
                    interleaved, and an <option>'s leading plain whitespace is
                    collapsed away. */}
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

        <div className="ml-auto flex items-center gap-2">
          {anyActive && (
            <Button variant="ghost" onClick={clearAll} className="px-3">
              <X className="h-4 w-4" />
              {"Clear"}
            </Button>
          )}
          {smartCategorizeEnabled && <SmartCategorizeButton count={unplacedCount} />}
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-40">
          <Field label="From">
            <Input
              type="date"
              value={serverFilters.from}
              onChange={(e) => setServerFilter("from", e.target.value)}
            />
          </Field>
        </div>

        <div className="w-40">
          <Field label="To">
            <Input
              type="date"
              value={serverFilters.to}
              onChange={(e) => setServerFilter("to", e.target.value)}
            />
          </Field>
        </div>

        {/* Amounts stay text + inputMode, never type="number": a number input
          hands back a coerced float, and money is an exact decimal string. */}
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
    </Card>
  );
}
