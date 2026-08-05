import Decimal from "decimal.js";

/**
 * A suggested ceiling, as a number a person would actually choose.
 *
 * The domain layer returns the mean unrounded and must keep doing so — it is
 * forbidden from rounding (money-and-currency.md §3) — but ₪1,242.68333333
 * is not a target anyone sets. Rounding up to the next ₪10 happens here, at
 * the display edge, and up rather than to-nearest because a ceiling rounded
 * down is a ceiling the user's own history already breaks.
 *
 * In `lib` rather than beside either of its callers because both the planner
 * wizard and the history tab's suggestions have to round the same way — two
 * screens proposing ₪1,250 and ₪1,242.68 for the same category would read as
 * a bug.
 */
export function roundCeiling(amount: string): string {
  return new Decimal(amount).dividedBy(10).ceil().times(10).toFixed();
}
