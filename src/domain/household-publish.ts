// Household shared budget — Option A: published running totals (issue #115).
//
// Each member's Moni recomputes THEIR OWN monthly total for each shared
// category (summing their flow entries across the local categories they mapped)
// and writes that single encrypted number into the household room under the
// group key. The combined view is "my live figure + each other member's last
// published figure" (household-budget.ts).
//
// Why this escapes the no-persisted-rollups ban (data-model.md §6.2): a publish
// is a recompute-and-OVERWRITE, not an encrypted read-modify-write, so it has
// no lost-update race. Each member writes only their own rows (RLS), so there
// is no cross-member contention either. The `version` bump is purely for the
// AAD rollback binding, so we read the current version and write version+1 in
// the same member-scoped transaction.
//
// Money math is the house rule, identical to the dashboard/budget: skip
// pending-FX entries, reporting = entered × the entry's own locked fx_rate, all
// decimal.js. A shared category is a spending line, so its published total is
// the spend magnitude (income in it nets down, exactly as the member's own
// budget "spent" would).
import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { and, eq, gte, lte } from "drizzle-orm";
import { withUser, type UserTransaction } from "@/db/client";
import {
  entries,
  householdMembers,
  publishedCategoryTotals,
  sharedCategories,
  sharedCategoryMaps,
} from "@/db/schema";
import { multiply } from "@/lib/money";
import { wipe } from "@/lib/crypto";
import { decText, encText } from "./fields";
import { countsAsFlow, loadTransferCategoryIds } from "./flows";
import { currentMonth, monthEnd, monthStart } from "./budget";
import { loadGroupKey } from "./household";

/**
 * Recomputes and republishes the caller's totals for every household they
 * belong to, for `months` (default: the current budget month). Opens its own
 * user-scoped transaction; safe to call after a mutation commits. A no-op for a
 * user in no household.
 */
export async function publishSharedTotals(
  userId: string,
  dataKey: Buffer,
  months?: string[],
): Promise<void> {
  await withUser(userId, (tx) => publishSharedTotalsInTx(tx, userId, dataKey, months));
}

/**
 * As {@link publishSharedTotals}, inside an existing user-scoped transaction —
 * so a write path (e.g. re-categorization) can republish synchronously in the
 * same transaction that moved the total.
 */
export async function publishSharedTotalsInTx(
  tx: UserTransaction,
  userId: string,
  dataKey: Buffer,
  months?: string[],
): Promise<void> {
  const targetMonths = months && months.length > 0 ? months : [currentMonth()];

  const memberships = await tx
    .select({ householdId: householdMembers.householdId })
    .from(householdMembers);
  if (memberships.length === 0) return;

  for (const { householdId } of memberships) {
    const groupKey = await loadGroupKey(tx, householdId, dataKey);
    if (!groupKey) continue;
    try {
      // My local→shared mapping for this household, shared_category_id → local ids.
      const maps = await tx
        .select({
          sharedCategoryId: sharedCategoryMaps.sharedCategoryId,
          localCategoryId: sharedCategoryMaps.localCategoryId,
        })
        .from(sharedCategoryMaps)
        .where(eq(sharedCategoryMaps.householdId, householdId));
      const localBySc = new Map<string, Set<string>>();
      for (const m of maps) {
        const set = localBySc.get(m.sharedCategoryId) ?? new Set<string>();
        set.add(m.localCategoryId);
        localBySc.set(m.sharedCategoryId, set);
      }

      const scs = await tx
        .select({ id: sharedCategories.id })
        .from(sharedCategories)
        .where(eq(sharedCategories.householdId, householdId));

      for (const month of targetMonths) {
        const perLocal = await myCategorySpend(tx, dataKey, month);
        for (const sc of scs) {
          const localIds = localBySc.get(sc.id);
          let total = new Decimal(0);
          if (localIds) {
            for (const id of localIds) total = total.plus(perLocal.get(id) ?? new Decimal(0));
          }
          await upsertPublishedTotal(tx, groupKey, {
            householdId,
            sharedCategoryId: sc.id,
            memberId: userId,
            month: monthStart(month),
            total: total.toString(),
          });
        }
      }
    } finally {
      wipe(groupKey);
    }
  }
}

/**
 * The caller's spend per local category for one month, as positive magnitudes
 * (expenses positive, income nets down) — the same figure the member's own
 * budget "spent" shows. RLS scopes this to the caller's ledger.
 */
export async function myCategorySpend(
  tx: UserTransaction,
  dataKey: Buffer,
  month: string,
): Promise<Map<string, Decimal>> {
  const rows = await tx
    .select()
    .from(entries)
    .where(and(gte(entries.date, monthStart(month)), lte(entries.date, monthEnd(month))));
  const transferCategoryIds = await loadTransferCategoryIds(tx);

  // Signed reporting sums first (expenses negative), negate at the end so the
  // published magnitude reads as spend.
  const signed = new Map<string, Decimal>();
  for (const e of rows) {
    if (!e.categoryId) continue;
    if (!countsAsFlow(e, transferCategoryIds)) continue;
    if (e.fxStatus === "pending" || !e.fxRate) continue;
    const entered = decText(dataKey, e.enteredAmountCt, e.id, "entered_amount_ct", e.version);
    if (entered == null) continue;
    const reporting = new Decimal(
      multiply({ amount: entered, currency: e.enteredCurrency }, e.fxRate).amount,
    );
    signed.set(e.categoryId, (signed.get(e.categoryId) ?? new Decimal(0)).plus(reporting));
  }
  const spend = new Map<string, Decimal>();
  for (const [id, sum] of signed) spend.set(id, sum.negated());
  return spend;
}

/**
 * Recompute-and-overwrite of one member's published total. Reads the current
 * version and writes version+1 with matching AAD (rollback binding). No
 * cross-member contention: RLS lets a member touch only their own rows.
 */
async function upsertPublishedTotal(
  tx: UserTransaction,
  groupKey: Buffer,
  row: {
    householdId: string;
    sharedCategoryId: string;
    memberId: string;
    month: string;
    total: string;
  },
): Promise<void> {
  const [existing] = await tx
    .select({ id: publishedCategoryTotals.id, version: publishedCategoryTotals.version })
    .from(publishedCategoryTotals)
    .where(
      and(
        eq(publishedCategoryTotals.householdId, row.householdId),
        eq(publishedCategoryTotals.sharedCategoryId, row.sharedCategoryId),
        eq(publishedCategoryTotals.memberId, row.memberId),
        eq(publishedCategoryTotals.month, row.month),
      ),
    );

  if (existing) {
    const version = existing.version + 1;
    await tx
      .update(publishedCategoryTotals)
      .set({
        totalCt: encText(groupKey, row.total, existing.id, "total_ct", version),
        publishedAt: new Date(),
        version,
      })
      .where(eq(publishedCategoryTotals.id, existing.id));
    return;
  }
  const id = randomUUID();
  await tx.insert(publishedCategoryTotals).values({
    id,
    householdId: row.householdId,
    sharedCategoryId: row.sharedCategoryId,
    memberId: row.memberId,
    month: row.month,
    totalCt: encText(groupKey, row.total, id, "total_ct", 1),
  });
}
