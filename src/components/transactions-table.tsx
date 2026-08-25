"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Money } from "@/components/money";
import { CategorizeDialog } from "@/components/categorize-dialog";
import { SuggestionChip } from "@/components/suggestion-chip";
import { TransactionsToolbar, type ServerFilters } from "@/components/transactions-toolbar";
import {
  applyTableControls,
  DEFAULT_TABLE_CONTROLS,
  payeeOf,
  type SortColumn,
  type TableControls,
  type ViewFilters,
} from "@/lib/transactions/table-view";
import { cn } from "@/lib/utils";
import type { CategoryView, SuggestionView } from "@/domain/categorization";
import type { EntryView } from "@/domain/transactions";

interface TransactionsTableProps {
  entries: EntryView[];
  categories: CategoryView[];
  /** Entry id -> proposed category, for the rows no rule could place. Absent
   * for anything already categorized or below the confidence bar. */
  suggestions: Record<string, SuggestionView>;
  /** The SQL-side filters currently in the URL, echoed into the toolbar. */
  serverFilters: ServerFilters;
  /** Income/Payment and expense-size, from the URL. Applied here over the
   * window, and — when `searchAll` — already applied completely by the server. */
  viewFilters: ViewFilters;
  /** True when Income/Payment and size were filtered across the whole history
   * server-side, so the "covers only the window" caveat doesn't apply to them. */
  searchAll: boolean;
  /** Asia/Jerusalem "today" from the server, for the timeframe presets. */
  today: string;
  /** How many entries the server was willing to return, so the table can say
   * how far the client-side search, sort and amount filters actually reach. */
  windowSize: number;
  /** True when the server found more entries than the window holds. Decided
   * there by over-fetching one row, not guessed from `entries.length`. */
  capped: boolean;
  smartCategorizeEnabled?: boolean;
}

// Payee and amount lead: they are what a ledger is scanned for, and putting
// them first means the two useful columns are visible before the table has to
// be scrolled sideways on a phone (#91).
const COLUMNS: { column: SortColumn; label: string; align?: "right" }[] = [
  { column: "payee", label: "Payee" },
  { column: "amount", label: "Amount", align: "right" },
  { column: "category", label: "Category" },
  { column: "date", label: "Date" },
  { column: "account", label: "Account" },
];

/** Client component so a row can open the categorize dialog, and so search,
 * amount range and sort can run at all — the payee and amount columns are
 * ciphertext in Postgres (`src/lib/transactions/table-view.ts`). Dates arrive
 * pre-formatted as `dateLabel`; formatting an ISO string on this side of the
 * boundary is a hydration mismatch (.agents/skills/ui-developer). */
export function TransactionsTable({
  entries,
  categories,
  suggestions,
  serverFilters,
  viewFilters,
  searchAll,
  today,
  windowSize,
  capped,
  smartCategorizeEnabled = false,
}: TransactionsTableProps) {
  const [selected, setSelected] = useState<EntryView | null>(null);
  const [controls, setControls] = useState<TableControls>(DEFAULT_TABLE_CONTROLS);

  const unplacedCount = useMemo(
    () =>
      new Set(
        entries
          .filter((e) => e.categoryId === null && !suggestions[e.id] && e.matchText !== "")
          .map((e) => e.matchText),
      ).size,
    [entries, suggestions],
  );

  const visible = useMemo(
    () => applyTableControls(entries, controls, viewFilters),
    [entries, controls, viewFilters],
  );

  function toggleSort(column: SortColumn) {
    setControls((c) => ({
      ...c,
      sort:
        c.sort.column === column
          ? { column, direction: c.sort.direction === "asc" ? "desc" : "asc" }
          : { column, direction: "asc" },
    }));
  }

  const hasAmountBound = controls.minAmount !== "" || controls.maxAmount !== "";
  // Income/Payment and size only refine the window client-side while
  // `searchAll` is off; with it on, the server already filtered them completely.
  const windowViewFiltered =
    !searchAll && (viewFilters.direction !== "all" || viewFilters.size !== "all");

  const notes: string[] = [];
  if (visible.length < entries.length) notes.push(`${visible.length} of ${entries.length} shown`);
  if (capped) {
    // Sorting has to be named here too, not just the filters. "Amount,
    // descending" over a truncated window presents the largest of the newest
    // hundred as if it were the largest outright — the most quietly wrong of
    // the three.
    notes.push(
      `Search, sorting and amount filters cover only the ${windowSize} most recent transactions in this range — narrow the dates to look further back.`,
    );
    if (windowViewFiltered) {
      // The remedy the user actually has for Income/Payment and size is the
      // Advanced Search toggle, so name it rather than the date workaround.
      notes.push(
        "Income/Payment and size cover only that window too — turn on “Search the whole timeframe” in Advanced Search to filter all of them.",
      );
    }
  }
  if (hasAmountBound) {
    // Currency belongs in this caveat alongside sign: a pending-FX row carries
    // its entered leg, not a base-currency figure, so the bound is compared
    // against a number in another currency (`EntryView.fxPending`).
    notes.push("Amount range matches a transaction's size, ignoring sign and currency.");
  }

  // An empty table has three quite different causes, and telling the user
  // "nothing matched" when they have never synced is the unhelpful one.
  const serverFiltered =
    serverFilters.category !== "" ||
    serverFilters.from !== "" ||
    serverFilters.to !== "" ||
    (searchAll && (viewFilters.direction !== "all" || viewFilters.size !== "all"));
  const emptyMessage =
    entries.length > 0
      ? "No transaction matches that search."
      : serverFiltered
        ? "No transactions match these filters."
        : "No transactions yet.";

  return (
    <div className="flex flex-col gap-4">
      <TransactionsToolbar
        categories={categories}
        serverFilters={serverFilters}
        viewFilters={viewFilters}
        searchAll={searchAll}
        today={today}
        controls={controls}
        onControlsChange={setControls}
        smartCategorizeEnabled={smartCategorizeEnabled}
        unplacedCount={unplacedCount}
      />

      {notes.length > 0 && (
        <p className="max-w-3xl text-xs text-muted-foreground">{notes.join(" · ")}</p>
      )}

      <Card className="overflow-hidden">
        {/* The scroll lives here, not on the page, so the header can stay put
            while a long ledger moves under it. */}
        <div className="max-h-[70vh] overflow-auto">
          {/* `border-separate` is load-bearing, not cosmetic. Under the default
              `border-collapse: collapse` a cell's border belongs to the table's
              collapsed border grid rather than to the cell, so it does not
              travel with a sticky <th> — the header loses its bottom rule the
              moment you scroll, and floats on the rows. Verified in the browser
              by toggling the property live. The cost: a border on a <tr> then
              renders nowhere, so the row rules have to live on the <td>s. */}
          <table className="w-full border-separate border-spacing-0 text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                {COLUMNS.map(({ column, label, align }) => {
                  const active = controls.sort.column === column;
                  return (
                    <th
                      key={column}
                      scope="col"
                      aria-sort={
                        active
                          ? controls.sort.direction === "asc"
                            ? "ascending"
                            : "descending"
                          : "none"
                      }
                      // Sticky sits on the cells rather than the row: a border
                      // on a sticky <tr> scrolls away from under it.
                      className={cn(
                        "sticky top-0 z-10 border-b border-border bg-card px-5 py-3 font-medium",
                        align === "right" && "text-right",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => toggleSort(column)}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-sm uppercase tracking-wide transition hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring",
                          active && "text-foreground",
                        )}
                      >
                        {label}
                        {/* The icon slot always renders, so sorting a column
                            never nudges the header text sideways. */}
                        {active ? (
                          controls.sort.direction === "asc" ? (
                            <ArrowUp className="h-3.5 w-3.5" />
                          ) : (
                            <ArrowDown className="h-3.5 w-3.5" />
                          )
                        ) : (
                          <ChevronsUpDown className="h-3.5 w-3.5 opacity-40" />
                        )}
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody className="[&>tr:last-child>td]:border-b-0">
              {visible.map((entry) => (
                <tr
                  key={entry.id}
                  // The whole row is the target, so it carries the button role
                  // and key handling rather than wrapping each cell.
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelected(entry)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelected(entry);
                    }
                  }}
                  className={cn(
                    "cursor-pointer transition hover:bg-muted focus:outline-none focus:ring-2 focus:ring-inset focus:ring-ring",
                    entry.excluded && "opacity-50",
                  )}
                >
                  <td className="border-b border-border px-5 py-3 text-foreground">
                    {/* Hebrew payee names reorder an adjacent LTR badge unless
                        they are bidi-isolated. */}
                    <bdi>{payeeOf(entry)}</bdi>
                    {entry.installmentLabel && (
                      <Badge className="ml-2">{entry.installmentLabel}</Badge>
                    )}
                    {entry.excluded && <Badge className="ml-2">transfer</Badge>}
                  </td>
                  <td className="whitespace-nowrap border-b border-border px-5 py-3 text-right">
                    {/* A transfer's sign says which side of the move you are
                        looking at, not whether money was earned or spent — so
                        it gets blue, not teal/coral. */}
                    <Money value={entry.amount} signColor transfer={entry.isTransfer} />
                    {entry.fxPending && <Badge className="ml-2">pending FX</Badge>}
                  </td>
                  <td className="border-b border-border px-5 py-3">
                    {entry.categoryName ? (
                      <Badge>{entry.categoryName}</Badge>
                    ) : suggestions[entry.id] ? (
                      <SuggestionChip
                        entryId={entry.id}
                        matchText={entry.matchText}
                        suggestion={suggestions[entry.id]}
                      />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap border-b border-border px-5 py-3 tabular-nums text-muted-foreground">
                    {entry.dateLabel}
                  </td>
                  <td className="border-b border-border px-5 py-3 text-foreground">
                    {entry.accountName}
                  </td>
                </tr>
              ))}
              {visible.length === 0 && (
                <tr>
                  <td
                    colSpan={COLUMNS.length}
                    className="px-5 py-8 text-center text-muted-foreground"
                  >
                    {emptyMessage}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <CategorizeDialog
        key={selected?.id}
        entry={selected}
        categories={categories}
        suggestedCategoryId={selected ? (suggestions[selected.id]?.categoryId ?? null) : null}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}
