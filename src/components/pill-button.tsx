"use client";

import { cn } from "@/lib/utils";

/**
 * The selectable pill used across the app's filter/preset groups — the
 * backfill window picker and the transactions filter both reach for it, so the
 * one accent idiom stays consistent. `aria-pressed` carries the selected state;
 * a 10% amber tint is an accent, not a fill (per `docs/design/ui-and-feel.md`).
 *
 * `min-h` gives a comfortable touch target on a phone, where these are the
 * primary filter control (#107).
 */
export function PillButton({
  selected,
  onClick,
  children,
  title,
  className,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      title={title}
      className={cn(
        "inline-flex min-h-[2.25rem] items-center justify-center rounded-[var(--radius)] border px-3 py-1.5 text-xs transition",
        selected
          ? "border-primary/60 bg-primary/10 text-foreground"
          : "border-border bg-card text-muted-foreground hover:border-primary/50 hover:bg-muted",
        className,
      )}
    >
      {children}
    </button>
  );
}
