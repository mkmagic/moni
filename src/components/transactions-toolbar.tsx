"use client";

import { useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, Search, X } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
// From `lib`, never from `@/domain/transactions`: importing a runtime value
// out of the domain layer pulls `pg` into the client bundle.
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
}

const fieldClass =
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
    startTransition(() => router.push("/transactions"));
  }

  return (
    <Card
      className="flex flex-wrap items-end gap-3 px-5 pb-4 pt-6"
      data-pending={pending ? "" : undefined}
    >
      <div className="min-w-[14rem] flex-1">
        <Field label="Search">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={controls.query}
              onChange={(e) => set("query", e.target.value)}
              placeholder="Search payee"
              className={`${fieldClass} pl-9`}
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
              className={`${fieldClass} appearance-none pr-8`}
            >
              <option value="">All categories</option>
              <option value={NO_CATEGORY}>Uncategorized</option>
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

      <div className="w-40">
        <Field label="From">
          <input
            type="date"
            value={serverFilters.from}
            onChange={(e) => setServerFilter("from", e.target.value)}
            className={fieldClass}
          />
        </Field>
      </div>

      <div className="w-40">
        <Field label="To">
          <input
            type="date"
            value={serverFilters.to}
            onChange={(e) => setServerFilter("to", e.target.value)}
            className={fieldClass}
          />
        </Field>
      </div>

      {/* Amounts stay text + inputMode, never type="number": a number input
          hands back a coerced float, and money is an exact decimal string. */}
      <div className="w-32">
        <Field label="Min amount">
          <input
            type="text"
            inputMode="decimal"
            value={controls.minAmount}
            onChange={(e) => set("minAmount", e.target.value)}
            placeholder="0"
            className={`${fieldClass} tabular-nums`}
          />
        </Field>
      </div>

      <div className="w-32">
        <Field label="Max amount">
          <input
            type="text"
            inputMode="decimal"
            value={controls.maxAmount}
            onChange={(e) => set("maxAmount", e.target.value)}
            placeholder="Any"
            className={`${fieldClass} tabular-nums`}
          />
        </Field>
      </div>

      {anyActive && (
        <Button variant="ghost" onClick={clearAll} className="px-3">
          <X className="h-4 w-4" />
          {"Clear"}
        </Button>
      )}
    </Card>
  );
}
