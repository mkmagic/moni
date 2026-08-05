/**
 * Valuing a native balance in ILS, under one rule: a Bank-of-Israel
 * observation no more than seven days old, never an invented or interpolated
 * rate (money-and-currency.md §5). An account with no usable rate is left out
 * of the total rather than counted at a guess.
 *
 * Lifted out of `dashboard.ts` when the accounts page needed per-group
 * subtotals. Two ILS totals derived by two rate rules would be two numbers the
 * user cannot reconcile against each other, so both callers share this one.
 */
import Decimal from "decimal.js";
import { and, desc, eq, lte } from "drizzle-orm";
import type { UserTransaction } from "@/db/client";
import { fxRates } from "@/db/schema";

/** How stale a BOI observation may be before a balance counts as unvalued. */
const MAX_RATE_AGE_DAYS = 7;

export async function usableIlsRate(
  tx: UserTransaction,
  currency: string,
  at: string,
): Promise<{ rate: Decimal; date: string } | null> {
  if (currency === "ILS") return { rate: new Decimal(1), date: at };
  const [row] = await tx
    .select()
    .from(fxRates)
    .where(
      and(eq(fxRates.fromCurrency, currency), eq(fxRates.toCurrency, "ILS"), lte(fxRates.date, at)),
    )
    .orderBy(desc(fxRates.date))
    .limit(1);
  if (!row || row.source !== "boi") return null;
  const age =
    (new Date(`${at}T00:00:00Z`).getTime() - new Date(`${row.date}T00:00:00Z`).getTime()) /
    86_400_000;
  return age >= 0 && age <= MAX_RATE_AGE_DAYS
    ? { rate: new Decimal(row.rate), date: row.date }
    : null;
}
