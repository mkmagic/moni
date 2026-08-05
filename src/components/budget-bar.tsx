import { cn } from "@/lib/utils";
import type { Money } from "@/lib/money";

interface BudgetBarProps {
  spent: Money;
  /** Ceiling plus anything rolled in — what the bar is measured against. */
  available: Money;
  /**
   * How far through the month today is, 0..1. Drawn as a tick showing where
   * spending *should* be by now, because "80% of Groceries gone" means
   * nothing without knowing it's the 8th. Null on Fixed rows and on any past
   * month: Rent is 100% spent on day one by design, and pacing a finished
   * month says nothing at all.
   */
  pace?: number | null;
}

/**
 * Spent-against-ceiling, as one bar.
 *
 * `Number()` here is display geometry, not money: it produces a CSS width,
 * never a figure anyone reads. Every amount on screen still goes through
 * `<Money>` (docs/design/money-and-currency.md §3/§6).
 */
export function BudgetBar({ spent, available, pace }: BudgetBarProps) {
  const ceiling = Number(available.amount);
  const used = Number(spent.amount);
  // A rolled-over deficit can drive `available` to zero or below, at which
  // point any spending at all is over budget — and dividing by it would say
  // the opposite. `over` is decided on the numbers, never on the ratio.
  const over = ceiling > 0 ? used > ceiling : used > 0;
  const ratio = ceiling > 0 ? used / ceiling : over ? 1 : 0;
  const width = Math.min(Math.max(ratio, 0), 1) * 100;
  const behindPace = pace != null && !over && ratio > pace;

  return (
    <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={cn(
          "h-full rounded-full transition-[width]",
          over ? "bg-negative" : behindPace ? "bg-primary" : "bg-positive",
        )}
        style={{ width: `${width}%` }}
      />
      {pace != null && (
        <span
          aria-hidden
          // Sits above the fill, so it stays readable once the bar passes it.
          className="absolute top-0 h-full w-px bg-foreground/60"
          style={{ left: `${Math.min(pace, 1) * 100}%` }}
        />
      )}
    </div>
  );
}
