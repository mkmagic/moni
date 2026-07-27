import { formatMoney, isNegative } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Money as MoneyValue } from "@/lib/money";

interface MoneyProps {
  value: MoneyValue;
  className?: string;
  /** Color the figure by sign (negative -> coral). Defaults to off (neutral foreground). */
  signColor?: boolean;
  /**
   * Overrides `signColor` with blue: the entry moves money rather than
   * earning or spending it, so its sign carries no good/bad meaning and
   * teal/coral would assert one. See `src/domain/flows.ts`.
   */
  transfer?: boolean;
}

/** Server-safe display of a Money value. Formatting only happens here, at the edge. */
export function Money({ value, className, signColor, transfer }: MoneyProps) {
  return (
    <span
      className={cn(
        "tabular-nums",
        transfer
          ? "text-transfer"
          : signColor && (isNegative(value) ? "text-negative" : "text-positive"),
        className,
      )}
    >
      {formatMoney(value)}
    </span>
  );
}
