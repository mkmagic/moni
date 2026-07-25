import { formatMoney, isNegative } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Money as MoneyValue } from "@/lib/money";

interface MoneyProps {
  value: MoneyValue;
  className?: string;
  /** Color the figure by sign (negative -> coral). Defaults to off (neutral foreground). */
  signColor?: boolean;
}

/** Server-safe display of a Money value. Formatting only happens here, at the edge. */
export function Money({ value, className, signColor }: MoneyProps) {
  return (
    <span
      className={cn(
        "tabular-nums",
        signColor && (isNegative(value) ? "text-negative" : "text-positive"),
        className,
      )}
    >
      {formatMoney(value)}
    </span>
  );
}
