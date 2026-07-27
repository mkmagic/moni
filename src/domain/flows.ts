// What counts as income or an expense — the single definition, so that every
// aggregate in the app agrees.
//
// Two things disqualify an entry from being a flow, and both are easy to
// forget when writing a new aggregate:
//
//   1. `excluded` — one leg of a paired internal transfer, or a row the user
//      deliberately took out of their totals.
//   2. A category classified `transfer` — money moved rather than earned or
//      spent. The load-bearing case is the monthly credit-card settlement:
//      the purchases it pays off are already in the ledger as entries on the
//      card account, so counting the settlement as an expense counts every
//      one of those purchases twice.
//
// Net worth is NOT computed from flows — it sums account balances
// (dashboard.ts, money-and-currency.md §5) — so neither rule affects it.
// Anything that sums entries, though, goes through here.
import { eq } from "drizzle-orm";
import { categories } from "@/db/schema";
import type { db } from "@/db/client";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Just enough of an entry row to judge it. */
export interface FlowCandidate {
  excluded: boolean;
  categoryId: string | null;
}

/**
 * The ids of every category the user has classified as a transfer. Load once
 * per aggregation, not per row — it is a small set and the caller is already
 * inside a transaction.
 */
export async function loadTransferCategoryIds(tx: Tx): Promise<Set<string>> {
  const rows = await tx
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.classification, "transfer"));
  return new Set(rows.map((r) => r.id));
}

/** Whether this entry belongs in an income/expense total. */
export function countsAsFlow(entry: FlowCandidate, transferCategoryIds: Set<string>): boolean {
  if (entry.excluded) return false;
  if (entry.categoryId && transferCategoryIds.has(entry.categoryId)) return false;
  return true;
}
