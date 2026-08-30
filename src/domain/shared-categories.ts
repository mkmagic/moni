// Household shared categories — the first-class shared budget lines, the split
// ratio, each member's local→shared mapping, and the group-owned household
// ceiling (issue #115).
//
// A shared category is NOT a reference to any member's local `categories` row:
// those are per-user (A's "Groceries" ≠ B's "Groceries"). Each member maps one
// or more of their OWN local categories onto the shared line; their published
// number is "my total across the local categories I mapped". The maps are
// member-private (RLS) — only the derived total ever crosses.
//
// The household ceiling is effective-dated with exactly the shape and reasoning
// of per-user `budget_ceilings`, but encrypted under the GROUP KEY (so it lives
// in the shared room) and settable by either member.
import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { and, asc, eq } from "drizzle-orm";
import { withUser, type UserTransaction } from "@/db/client";
import {
  householdBudgetCeilings,
  sharedCategories,
  sharedCategoryMaps,
  sharedCategorySplits,
} from "@/db/schema";
import { DECIMAL_STRING_PATTERN } from "@/lib/money";
import { decText, encText } from "./fields";
import { wipe } from "@/lib/crypto";
import { loadGroupKey, listHouseholdMemberIds } from "./household";

export class SharedCategoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SharedCategoryError";
  }
}

/** "YYYY-MM" (or "YYYY-MM-DD") -> "YYYY-MM-01", the stored `effective_from`. */
function monthFirstDay(month: string): string {
  return `${month.slice(0, 7)}-01`;
}

export interface SplitWeight {
  memberId: string;
  /** Exact-decimal weight in [0, 1]. */
  weight: string;
}

export interface SharedCategoryView {
  id: string;
  householdId: string;
  name: string;
  isRecurring: boolean;
  /** Per-member split weights (both members), exact-decimal strings. */
  splits: SplitWeight[];
  /** The caller's own local category ids folded into this line. */
  myLocalCategoryIds: string[];
  /** The household ceiling in force for `month`, or null if none/ended. */
  ceiling: string | null;
}

/**
 * Creates a shared budget line in a household the caller belongs to. `name` is
 * plaintext and deliberately shared with every member.
 */
export async function createSharedCategory(
  userId: string,
  householdId: string,
  name: string,
  opts: { isRecurring?: boolean } = {},
): Promise<{ sharedCategoryId: string }> {
  const sharedCategoryId = randomUUID();
  await withUser(userId, async (tx) => {
    await assertMember(tx, householdId, userId);
    await tx.insert(sharedCategories).values({
      id: sharedCategoryId,
      householdId,
      name,
      isRecurring: opts.isRecurring ?? false,
      createdBy: userId,
    });
  });
  return { sharedCategoryId };
}

/**
 * Sets the split for a shared category — one weight per member. Validates every
 * member id is a real member, every weight is in [0, 1], and the weights sum to
 * exactly 1. Replaces the whole split atomically (either member may set it).
 */
export async function setSplit(
  userId: string,
  householdId: string,
  sharedCategoryId: string,
  weights: SplitWeight[],
): Promise<void> {
  await withUser(userId, async (tx) => {
    const members = new Set(await listHouseholdMemberIds(tx, householdId));
    if (members.size === 0) throw new SharedCategoryError("not a member of this household");

    let sum = new Decimal(0);
    for (const w of weights) {
      if (!members.has(w.memberId)) {
        throw new SharedCategoryError("split names a non-member");
      }
      if (!DECIMAL_STRING_PATTERN.test(w.weight)) {
        throw new SharedCategoryError(`invalid weight "${w.weight}"`);
      }
      const d = new Decimal(w.weight);
      if (d.isNegative() || d.greaterThan(1)) {
        throw new SharedCategoryError("weight must be between 0 and 1");
      }
      sum = sum.plus(d);
    }
    if (!sum.equals(1)) {
      throw new SharedCategoryError("split weights must sum to exactly 1");
    }

    await tx
      .delete(sharedCategorySplits)
      .where(
        and(
          eq(sharedCategorySplits.householdId, householdId),
          eq(sharedCategorySplits.sharedCategoryId, sharedCategoryId),
        ),
      );
    if (weights.length > 0) {
      await tx.insert(sharedCategorySplits).values(
        weights.map((w) => ({
          householdId,
          sharedCategoryId,
          memberId: w.memberId,
          weight: w.weight,
        })),
      );
    }
  });
}

/**
 * Maps one of the caller's OWN local categories onto a shared line. The
 * composite (member_id, local_category_id) FK makes mapping another member's
 * category impossible at the database; RLS keeps the map member-private.
 */
export async function mapLocalCategory(
  userId: string,
  householdId: string,
  sharedCategoryId: string,
  localCategoryId: string,
): Promise<void> {
  await withUser(userId, async (tx) => {
    await tx
      .insert(sharedCategoryMaps)
      .values({ householdId, sharedCategoryId, memberId: userId, localCategoryId })
      .onConflictDoNothing();
  });
}

/** Removes one of the caller's local categories from a shared line. */
export async function unmapLocalCategory(
  userId: string,
  householdId: string,
  sharedCategoryId: string,
  localCategoryId: string,
): Promise<void> {
  await withUser(userId, async (tx) => {
    await tx
      .delete(sharedCategoryMaps)
      .where(
        and(
          eq(sharedCategoryMaps.sharedCategoryId, sharedCategoryId),
          eq(sharedCategoryMaps.memberId, userId),
          eq(sharedCategoryMaps.localCategoryId, localCategoryId),
        ),
      );
  });
}

/**
 * The caller's local category ids that are mapped to ANY shared category. Used
 * by the per-user budget to suppress a personal ceiling on a now-shared branch
 * (its budget is the household ceiling). RLS confines this to the caller's own
 * maps, so no data key is needed.
 */
export async function mappedLocalCategoryIds(tx: UserTransaction): Promise<Set<string>> {
  const rows = await tx
    .select({ localCategoryId: sharedCategoryMaps.localCategoryId })
    .from(sharedCategoryMaps);
  return new Set(rows.map((r) => r.localCategoryId));
}

/** As {@link mappedLocalCategoryIds}, opening its own user-scoped transaction. */
export async function myMappedLocalCategoryIds(userId: string): Promise<Set<string>> {
  return withUser(userId, (tx) => mappedLocalCategoryIds(tx));
}

/**
 * Sets the household ceiling for a shared category from `effectiveFrom` forward
 * — effective-dated like a per-user ceiling, but encrypted under the group key.
 * Editing the same month replaces that row; a later month adds one. `amount` is
 * a positive canonical decimal string.
 */
export async function setHouseholdCeiling(
  userId: string,
  dataKey: Buffer,
  householdId: string,
  sharedCategoryId: string,
  amount: string,
  effectiveFrom: string,
  rollover: boolean,
): Promise<void> {
  if (!DECIMAL_STRING_PATTERN.test(amount) || new Decimal(amount).isNegative()) {
    throw new SharedCategoryError(`invalid ceiling amount "${amount}"`);
  }
  await withUser(userId, async (tx) => {
    const groupKey = await loadGroupKey(tx, householdId, dataKey);
    if (!groupKey) throw new SharedCategoryError("not a member of this household");
    try {
      const from = monthFirstDay(effectiveFrom);
      const [existing] = await tx
        .select()
        .from(householdBudgetCeilings)
        .where(
          and(
            eq(householdBudgetCeilings.householdId, householdId),
            eq(householdBudgetCeilings.sharedCategoryId, sharedCategoryId),
            eq(householdBudgetCeilings.effectiveFrom, from),
          ),
        );
      if (existing) {
        const version = existing.version + 1;
        await tx
          .update(householdBudgetCeilings)
          .set({
            amountCt: encText(groupKey, amount, existing.id, "amount_ct", version),
            rollover,
            version,
          })
          .where(eq(householdBudgetCeilings.id, existing.id));
        return;
      }
      const id = randomUUID();
      await tx.insert(householdBudgetCeilings).values({
        id,
        householdId,
        sharedCategoryId,
        amountCt: encText(groupKey, amount, id, "amount_ct", 1),
        effectiveFrom: from,
        rollover,
      });
    } finally {
      wipe(groupKey);
    }
  });
}

/**
 * Reads shared categories for a household the caller belongs to — with the
 * split, the caller's own maps, and the ceiling in force for `month` (decrypted
 * with the group key). Returns [] if the caller is not a member.
 */
export async function listSharedCategories(
  userId: string,
  dataKey: Buffer,
  householdId: string,
  month: string,
): Promise<SharedCategoryView[]> {
  return withUser(userId, async (tx) => {
    const groupKey = await loadGroupKey(tx, householdId, dataKey);
    if (!groupKey) return [];
    try {
      const cats = await tx
        .select()
        .from(sharedCategories)
        .where(eq(sharedCategories.householdId, householdId));
      const splits = await tx
        .select()
        .from(sharedCategorySplits)
        .where(eq(sharedCategorySplits.householdId, householdId));
      const maps = await tx
        .select()
        .from(sharedCategoryMaps)
        .where(eq(sharedCategoryMaps.householdId, householdId));
      const ceilingRows = await tx
        .select()
        .from(householdBudgetCeilings)
        .where(eq(householdBudgetCeilings.householdId, householdId))
        .orderBy(asc(householdBudgetCeilings.effectiveFrom));

      const asOf = monthFirstDay(month);
      return cats.map((c) => ({
        id: c.id,
        householdId: c.householdId,
        name: c.name,
        isRecurring: c.isRecurring,
        splits: splits
          .filter((s) => s.sharedCategoryId === c.id)
          .map((s) => ({ memberId: s.memberId, weight: s.weight })),
        myLocalCategoryIds: maps
          .filter((m) => m.sharedCategoryId === c.id)
          .map((m) => m.localCategoryId),
        ceiling: effectiveCeiling(groupKey, ceilingRows, c.id, asOf),
      }));
    } finally {
      wipe(groupKey);
    }
  });
}

type CeilingRow = typeof householdBudgetCeilings.$inferSelect;

/**
 * The household ceiling in force for a shared category as of `asOf` — the
 * latest effective row on or before that month, decrypted with the group key.
 * A null `amount_ct` ends the line, so it reads as "no ceiling".
 */
export function effectiveCeiling(
  groupKey: Buffer,
  rows: CeilingRow[],
  sharedCategoryId: string,
  asOf: string,
): string | null {
  let inForce: CeilingRow | null = null;
  for (const row of rows) {
    if (row.sharedCategoryId !== sharedCategoryId) continue;
    if (row.effectiveFrom <= asOf) inForce = row;
  }
  if (!inForce || !inForce.amountCt) return null;
  return decText(groupKey, inForce.amountCt, inForce.id, "amount_ct", inForce.version);
}

/** Throws unless `userId` is a member of `householdId` (RLS-backed check). */
async function assertMember(
  tx: UserTransaction,
  householdId: string,
  userId: string,
): Promise<void> {
  const members = await listHouseholdMemberIds(tx, householdId);
  if (!members.includes(userId)) {
    throw new SharedCategoryError("not a member of this household");
  }
}
