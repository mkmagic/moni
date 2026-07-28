"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Money } from "@/components/money";
import { CategorizeDialog } from "@/components/categorize-dialog";
import { SuggestionChip } from "@/components/suggestion-chip";
import type { CategoryView, SuggestionView } from "@/domain/categorization";
import type { EntryView } from "@/domain/transactions";

interface NeedsReviewCardProps {
  entries: EntryView[];
  categories: CategoryView[];
  /** Entry id -> proposed category. Rows without one just show no chip. */
  suggestions: Record<string, SuggestionView>;
}

/**
 * The review queue: everything the rules couldn't place. Rows are the
 * clickable elements, so the card itself gets no hover glow — in this UI the
 * glow means "this card is a link" (docs/design/ui-and-feel.md).
 */
export function NeedsReviewCard({ entries, categories, suggestions }: NeedsReviewCardProps) {
  const [selected, setSelected] = useState<EntryView | null>(null);

  if (entries.length === 0) {
    return (
      <Card>
        <CardHeader className="pt-6">
          <CardTitle>Needs categorizing</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{"Everything's categorized."}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader className="flex-row items-baseline justify-between pt-6">
          <CardTitle>Needs categorizing</CardTitle>
          <span className="text-sm tabular-nums text-foreground">{entries.length}</span>
        </CardHeader>
        <CardContent className="px-0">
          <ul className="max-h-[22rem] divide-y divide-border overflow-y-auto">
            {entries.map((entry) => (
              // The chip carries its own buttons, so it sits BESIDE the row
              // button rather than inside it — a button inside a button is
              // invalid and swallows the inner click.
              <li key={entry.id} className="flex items-center gap-2 pr-5 transition hover:bg-muted">
                <button
                  type="button"
                  onClick={() => setSelected(entry)}
                  className="flex min-w-0 flex-1 items-center gap-4 px-5 py-3 text-left focus:outline-none focus:ring-2 focus:ring-inset focus:ring-ring"
                >
                  <span className="w-24 shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                    {entry.dateLabel}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    <bdi>{entry.merchantName ?? entry.description}</bdi>
                  </span>
                  <span className="shrink-0 text-sm">
                    <Money value={entry.amount} signColor />
                  </span>
                </button>
                {/* Fixed-width slot, rendered whether or not there is a
                    suggestion. The row button is `flex-1`, so letting this
                    column size to its content would shift every amount left
                    by a different distance and break the money column. */}
                <span className="flex w-44 shrink-0 justify-end">
                  {suggestions[entry.id] && (
                    <SuggestionChip
                      entryId={entry.id}
                      matchText={entry.matchText}
                      suggestion={suggestions[entry.id]}
                    />
                  )}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
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
