// Display-edge money formatting. This is the ONLY place a money value is
// widened from its exact decimal string to a Number, and it happens purely
// for presentation (docs/design/money-and-currency.md §3/§6 — rounding and
// formatting live at the edge, never in the domain layer).
import type { Money } from "@/lib/money";

interface FormatOptions {
  locale?: string;
  /** Intl signDisplay — default "auto" (negatives get a leading minus). */
  signDisplay?: "auto" | "never" | "always" | "exceptZero";
}

/**
 * Formats a Money value to its display string (symbol + grouped digits +
 * minor units), rounding half-up at the currency's minor unit. The exact
 * value has already been computed as a string in the domain layer; the
 * Number() conversion here is the deliberate display-edge widening.
 */
export function formatMoney(money: Money, opts: FormatOptions = {}): string {
  return new Intl.NumberFormat(opts.locale ?? "en-US", {
    style: "currency",
    currency: money.currency,
    roundingMode: "halfExpand", // half away from zero == half-up for the shown value
    signDisplay: opts.signDisplay ?? "auto",
  }).format(Number(money.amount));
}

/** True if the amount is negative (outflow/liability) — for choosing text color. */
export function isNegative(money: Money): boolean {
  return money.amount.trimStart().startsWith("-");
}
