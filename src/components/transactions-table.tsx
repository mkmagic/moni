"use client";

import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Money } from "@/components/money";
import { CategorizeDialog } from "@/components/categorize-dialog";
import { SuggestionChip } from "@/components/suggestion-chip";
import { cn } from "@/lib/utils";
import type { CategoryView, SuggestionView } from "@/domain/categorization";
import type { EntryView } from "@/domain/transactions";

interface TransactionsTableProps {
  entries: EntryView[];
  categories: CategoryView[];
  /** Entry id -> proposed category, for the rows no rule could place. Absent
   * for anything already categorized or below the confidence bar. */
  suggestions: Record<string, SuggestionView>;
}

/** Client component so a row can open the categorize dialog. Dates arrive
 * pre-formatted as `dateLabel` — formatting an ISO string on this side of
 * the boundary is a hydration mismatch (.agents/skills/ui-developer). */
export function TransactionsTable({ entries, categories, suggestions }: TransactionsTableProps) {
  const [selected, setSelected] = useState<EntryView | null>(null);

  return (
    <>
      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-5 py-3 font-medium">Date</th>
              <th className="px-5 py-3 font-medium">Account</th>
              <th className="px-5 py-3 font-medium">Category</th>
              <th className="px-5 py-3 font-medium">Payee</th>
              <th className="px-5 py-3 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {entries.map((entry) => (
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
                <td className="whitespace-nowrap px-5 py-3 tabular-nums text-muted-foreground">
                  {entry.dateLabel}
                </td>
                <td className="px-5 py-3 text-foreground">{entry.accountName}</td>
                <td className="px-5 py-3">
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
                <td className="px-5 py-3 text-foreground">
                  {/* Hebrew payee names reorder an adjacent LTR badge unless
                      they are bidi-isolated. */}
                  <bdi>{entry.merchantName ?? entry.description}</bdi>
                  {entry.excluded && <Badge className="ml-2">transfer</Badge>}
                </td>
                <td className="whitespace-nowrap px-5 py-3 text-right">
                  {/* A transfer's sign says which side of the move you are
                      looking at, not whether money was earned or spent — so
                      it gets blue, not teal/coral. */}
                  <Money value={entry.amount} signColor transfer={entry.isTransfer} />
                  {entry.fxPending && <Badge className="ml-2">pending FX</Badge>}
                </td>
              </tr>
            ))}
            {entries.length === 0 && (
              <tr>
                <td colSpan={5} className="px-5 py-8 text-center text-muted-foreground">
                  No transactions yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      <CategorizeDialog
        key={selected?.id}
        entry={selected}
        categories={categories}
        suggestedCategoryId={selected ? (suggestions[selected.id]?.categoryId ?? null) : null}
        onClose={() => setSelected(null)}
      />
    </>
  );
}
