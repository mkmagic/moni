// Exact-decimal money helpers (decimal.js-backed) land here (T4). See
// docs/design/money-and-currency.md. Never a JS number/float for money, not
// even transiently — every function here goes string -> Decimal -> string.
// The one deliberate exception is from-scraper-number.ts, re-exported below
// — see its header for why it exists at all.
import Decimal from "decimal.js";
export { decimalStringFromScraperNumber } from "./from-scraper-number";

/**
 * Canonical decimal-string money value. `amount` is never a JS number.
 * `currency` is an ISO-4217-ish code (e.g. "ILS", "USD").
 */
export interface Money {
  amount: string;
  currency: string;
}

/** Matches the canonical decimal-string shape: optional `-`, digits, optional `.digits`. */
export const DECIMAL_STRING_PATTERN = /^-?\d+(\.\d+)?$/;

function toDecimal(amount: string): Decimal {
  return new Decimal(amount);
}

/**
 * Adds two Money values. Throws if currencies differ — this layer never
 * implicitly converts currency; FX conversion is a domain-layer concern
 * (money-and-currency.md §5) that needs an `fx_rates` lookup this module
 * doesn't have access to.
 */
export function add(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new Error(`Cannot add Money of different currencies: ${a.currency} vs ${b.currency}`);
  }
  return { amount: toDecimal(a.amount).plus(toDecimal(b.amount)).toString(), currency: a.currency };
}

/**
 * Multiplies a Money value by a scalar factor (e.g. `entered_amount ×
 * fx_rate` per data-model.md §4.3). `factor` may be a decimal string or a
 * `Decimal` — never a JS number.
 */
export function multiply(m: Money, factor: string | Decimal): Money {
  const f = factor instanceof Decimal ? factor : new Decimal(factor);
  return { amount: toDecimal(m.amount).times(f).toString(), currency: m.currency };
}

/**
 * Divides a Money value by a scalar — the recurring view's "average of the
 * last 3" (docs/adr/0006-*).
 *
 * Deliberately does **not** round. This function is the one place in the
 * module where a result need not terminate (10 / 3), and the tempting fix is
 * to round to the minor unit here — but money-and-currency.md §3 is explicit:
 * "Never round intermediate arithmetic. Compute at full decimal.js
 * precision", and "Rounding **never** happens in the domain/service layer."
 * The display edge already rounds: `formatMoney` applies `halfExpand` at the
 * currency's minor unit, so an average of 3.3333… renders as ₪3.33 with no
 * help from here.
 */
export function divide(m: Money, divisor: string | Decimal): Money {
  const d = divisor instanceof Decimal ? divisor : new Decimal(divisor);
  if (d.isZero()) {
    throw new Error("Cannot divide Money by zero");
  }
  return { amount: toDecimal(m.amount).dividedBy(d).toString(), currency: m.currency };
}

/** The magnitude of a Money value — an expense reported as a positive figure. */
export function abs(m: Money): Money {
  return { amount: toDecimal(m.amount).abs().toString(), currency: m.currency };
}

/** True if the amount is exactly zero. */
export function isZero(m: Money): boolean {
  return toDecimal(m.amount).isZero();
}

/** Returns a new Money with the amount's sign flipped. */
export function negate(m: Money): Money {
  return { amount: toDecimal(m.amount).negated().toString(), currency: m.currency };
}
