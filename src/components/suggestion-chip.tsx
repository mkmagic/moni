"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SuggestionView } from "@/domain/categorization";

interface SuggestionChipProps {
  entryId: string;
  /** The entry's match text — what a rejection is keyed on, so one ✗ clears
   * this guess from every transaction sharing the text. */
  matchText: string;
  suggestion: SuggestionView;
}

/**
 * A proposed category on an uncategorized row, with accept and reject.
 *
 * **Dashed border, muted text.** A solid `Badge` means "this IS the
 * category"; a suggestion is not one until a person says so, and the two must
 * never be mistaken for each other at a glance.
 *
 * **Neither button is amber.** Amber is one accent per view
 * (.agents/skills/ui-developer, 2026-07-26), and a table of twenty rows would
 * otherwise carry twenty of them. Accept goes teal on hover, reject coral —
 * borrowed from the money colors, where teal already reads as affirmative.
 *
 * Accepting is an ordinary categorization: the same `PATCH /api/entries/[id]`
 * the dialog uses, which sets the category and LOCKS it against every future
 * rule (docs/design/categorization.md §4).
 */
export function SuggestionChip({ entryId, matchText, suggestion }: SuggestionChipProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function send(url: string, method: "PATCH" | "POST", body: unknown) {
    setBusy(true);
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (res.ok) router.refresh();
  }

  const accept = () =>
    void send(`/api/entries/${entryId}`, "PATCH", { categoryId: suggestion.categoryId });
  const reject = () =>
    void send("/api/rejections", "POST", { matchText, categoryId: suggestion.categoryId });

  // The evidence, as its own string expressions — plain JSX text adjacent to
  // an expression loses its separating space at build time (ui-developer,
  // 2026-07-26).
  const evidence =
    suggestion.matchedSource === "rule"
      ? "matches your rule"
      : suggestion.matchedSource === "builtin"
        ? "looks like"
        : suggestion.supportCount > 1
          ? `filed this way ${suggestion.supportCount}× for`
          : "filed this way for";

  return (
    <span
      className="inline-flex min-w-0 items-center gap-1"
      // Rows are clickable and open the categorize dialog; the chip's own
      // buttons must not also trigger that.
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <span
        className="inline-flex min-w-0 items-center truncate rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground"
        // The matched text is a scraped payee string and routinely Hebrew;
        // inside this LTR sentence it reorders the words around it unless
        // isolated (docs/design/categorization.md §12). A title attribute
        // cannot hold JSX, so this is the FSI/PDI pair rather than <bdi>.
        title={`${evidence} ⁨${suggestion.matchedText}⁩`}
      >
        {suggestion.categoryName}
      </span>
      <button
        type="button"
        disabled={busy}
        aria-label={`Accept ${suggestion.categoryName}`}
        onClick={accept}
        className={cn(
          "rounded-full p-1 text-muted-foreground transition",
          "hover:bg-muted hover:text-positive focus:outline-none focus:ring-2 focus:ring-ring",
          busy && "opacity-50",
        )}
      >
        <Check className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        disabled={busy}
        aria-label={`Reject ${suggestion.categoryName}`}
        onClick={reject}
        className={cn(
          "rounded-full p-1 text-muted-foreground transition",
          "hover:bg-muted hover:text-negative focus:outline-none focus:ring-2 focus:ring-ring",
          busy && "opacity-50",
        )}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </span>
  );
}
