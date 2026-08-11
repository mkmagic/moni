"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Money } from "@/components/money";
import { CategorizeDialog } from "@/components/categorize-dialog";
import { SuggestionChip } from "@/components/suggestion-chip";
import { SmartCategorizeButton } from "@/components/smart-categorize-button";
import type { CategoryView, SuggestionView } from "@/domain/categorization";
import type { EntryView } from "@/domain/transactions";

interface NeedsReviewCardProps {
  entries: EntryView[];
  categories: CategoryView[];
  /** Entry id -> proposed category. Rows without one just show no chip. */
  suggestions: Record<string, SuggestionView>;
  smartCategorizeEnabled?: boolean;
}

/**
 * The review queue: everything the rules couldn't place. Rows are the
 * clickable elements, so the card itself gets no hover glow — in this UI the
 * glow means "this card is a link" (docs/design/ui-and-feel.md).
 */
export function NeedsReviewCard({
  entries,
  categories,
  suggestions,
  smartCategorizeEnabled = false,
}: NeedsReviewCardProps) {
  const [selected, setSelected] = useState<EntryView | null>(null);

  // Distinct uncategorized match texts that currently have no suggestion chip
  const unplacedCount = new Set(
    entries.filter((e) => !suggestions[e.id] && e.matchText !== "").map((e) => e.matchText),
  ).size;

  // Actionable rows first. This card is a work queue, not a ledger — a row
  // you can clear in one click outranks one that needs the dialog. `sort` is
  // stable, so newest-first survives inside each group. Sorted here rather
  // than in the page because the ordering follows from what this card is FOR,
  // and a future caller shouldn't have to remember it.
  const queue = [...entries].sort(
    (a, b) => Number(Boolean(suggestions[b.id])) - Number(Boolean(suggestions[a.id])),
  );

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
        <CardHeader className="flex-row items-center justify-between pt-6">
          <div className="flex items-center gap-3">
            <CardTitle>Needs categorizing</CardTitle>
            <span className="text-sm tabular-nums text-foreground">{entries.length}</span>
          </div>
          {smartCategorizeEnabled && <SmartCategorizeButton count={unplacedCount} />}
        </CardHeader>
        <CardContent className="px-0">
          <ul className="max-h-[22rem] divide-y divide-border overflow-y-auto">
            {queue.map((entry) => (
              <li
                key={entry.id}
                className="relative flex items-center gap-4 px-5 py-3 transition hover:bg-muted"
              >
                {/* The whole row opens the categorize dialog, but the chip
                    carries its own accept/reject buttons — a button inside a
                    button is invalid. So the click target is a transparent
                    overlay sibling, and the chip sits ABOVE it (`z-10`) so its
                    buttons still receive the click. This lets the suggestion sit
                    right beside the name rather than in a far-right slot. */}
                <button
                  type="button"
                  onClick={() => setSelected(entry)}
                  aria-label={`Categorize ${entry.merchantName ?? entry.description}`}
                  className="absolute inset-0 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-ring"
                />
                <span className="w-20 shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                  {entry.dateLabel}
                </span>
                {/* Wraps when the row is too narrow for name + chip on one
                    line, dropping the chip beneath the name rather than
                    ellipsising the merchant (dashboard-redesign/plan.md). */}
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1.5">
                  <span className="min-w-0 max-w-full truncate text-sm text-foreground">
                    <bdi>{entry.merchantName ?? entry.description}</bdi>
                  </span>
                  {suggestions[entry.id] && (
                    <span className="relative z-10 shrink-0">
                      <SuggestionChip
                        entryId={entry.id}
                        matchText={entry.matchText}
                        suggestion={suggestions[entry.id]}
                      />
                    </span>
                  )}
                </div>
                <span className="shrink-0 text-sm">
                  <Money value={entry.amount} signColor />
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
