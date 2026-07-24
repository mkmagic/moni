// Exact-decimal money helpers (decimal.js-backed) land here (T4). See
// docs/design/money-and-currency.md. Never a JS number/float for money, not
// even transiently — every function here goes string -> Decimal -> string.
import Decimal from "decimal.js";

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

/** True if the amount is exactly zero. */
export function isZero(m: Money): boolean {
  return toDecimal(m.amount).isZero();
}

/** Returns a new Money with the amount's sign flipped. */
export function negate(m: Money): Money {
  return { amount: toDecimal(m.amount).negated().toString(), currency: m.currency };
}
