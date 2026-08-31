// Household shared budget & settlement — the combined view and the "who owes
// whom" it yields for free (issue #115).
//
// Combined view = MY live figure (recomputed from my own ledger right now) + each
// other member's LAST-PUBLISHED figure. Freshness is "as of each member's last
// publish", surfaced per the house provenance rule; a member who has not
// reported this period is shown explicitly (never a silent ₪0) and makes the
// figure provisional.
//
// Settlement is the SAME combined number read a second way: apply the split
// weights → each member's share; owe = share − what they paid; net all shared
// categories into ONE true-up per pair. All split math is decimal.js and the
// nets CONSERVE to exactly zero via a deterministic leftover-agora rule
// (largest fractional remainder, tie-break by member id).
//
// Reading the combined view also republishes MY own totals first (the app-open
// trigger): whenever a member looks at the household, their published number is
// brought current for the other member.
import Decimal from "decimal.js";
import { and, eq } from "drizzle-orm";
import { withUser, type UserTransaction } from "@/db/client";
import {
  householdBudgetCeilings,
  publishedCategoryTotals,
  sharedCategories,
  sharedCategoryMaps,
  sharedCategorySplits,
} from "@/db/schema";
import { wipe } from "@/lib/crypto";
import { decText } from "./fields";
import { currentMonth, monthStart } from "./budget";
import { loadGroupKey, listHouseholdMemberIds, listMemberships } from "./household";
import { effectiveCeiling } from "./shared-categories";
import { myCategorySpend, publishSharedTotalsInTx } from "./household-publish";

export interface MemberFigure {
  memberId: string;
  /** This member's spend in the shared category this month (exact string). */
  amount: string;
  /** ISO timestamp of their last publish, or null when it is MY live figure. */
  asOf: string | null;
  /** True for the caller's own live figure. */
  isLive: boolean;
  /** True when this member has not published this period. `amount` is then "0"
   * and does not count toward the combined figure. */
  notReported: boolean;
}

export interface CombinedCategory {
  sharedCategoryId: string;
  name: string;
  /** Household ceiling in force for the month, or null. */
  ceiling: string | null;
  /** MY live figure + every other member's last-published figure (exact). */
  combined: string;
  /** The caller's own live figure (exact). */
  myFigure: string;
  perMember: MemberFigure[];
  /** True when at least one member has not reported this period. */
  provisional: boolean;
}

export interface HouseholdBudgetView {
  householdId: string;
  month: string;
  categories: CombinedCategory[];
  /** True when ANY shared category is provisional. */
  provisional: boolean;
  /** Oldest "as of" across all members' figures (ISO), or null if all live. */
  freshnessAsOf: string | null;
}

/**
 * The combined household budget for a month: per shared category, the combined
 * actual (my live + others' published) against the household ceiling. Also
 * republishes MY own totals first (app-open trigger). Returns null if the
 * caller is not a member.
 */
export async function getHouseholdBudget(
  userId: string,
  dataKey: Buffer,
  householdId: string,
  month: string = currentMonth(),
): Promise<HouseholdBudgetView | null> {
  return withUser(userId, async (tx) => {
    // App-open trigger: bring my own published number current for the partner.
    await publishSharedTotalsInTx(tx, userId, dataKey, [month]);

    const groupKey = await loadGroupKey(tx, householdId, dataKey);
    if (!groupKey) return null;
    try {
      const built = await buildCombined(tx, userId, dataKey, groupKey, householdId, month);
      if (!built) return null;
      let anyProvisional = false;
      let freshest: string | null = null;
      for (const c of built.categories) {
        if (c.provisional) anyProvisional = true;
        for (const m of c.perMember) {
          if (m.asOf && (freshest === null || m.asOf < freshest)) freshest = m.asOf;
        }
      }
      return {
        householdId,
        month,
        categories: built.categories,
        provisional: anyProvisional,
        freshnessAsOf: freshest,
      };
    } finally {
      wipe(groupKey);
    }
  });
}

interface BuiltCombined {
  categories: CombinedCategory[];
  members: string[];
}

/** Assembles the per-category combined figures. Assumes an open group key. */
async function buildCombined(
  tx: UserTransaction,
  userId: string,
  dataKey: Buffer,
  groupKey: Buffer,
  householdId: string,
  month: string,
): Promise<BuiltCombined | null> {
  const members = await listHouseholdMemberIds(tx, householdId);
  if (members.length === 0) return null;
  const monthKey = monthStart(month);

  const scs = await tx
    .select({ id: sharedCategories.id, name: sharedCategories.name })
    .from(sharedCategories)
    .where(eq(sharedCategories.householdId, householdId));

  // My mapping: shared_category_id -> my local category ids.
  const myMaps = await tx
    .select({
      sharedCategoryId: sharedCategoryMaps.sharedCategoryId,
      localCategoryId: sharedCategoryMaps.localCategoryId,
    })
    .from(sharedCategoryMaps)
    .where(eq(sharedCategoryMaps.householdId, householdId));
  const myLocalBySc = new Map<string, Set<string>>();
  for (const m of myMaps) {
    const set = myLocalBySc.get(m.sharedCategoryId) ?? new Set<string>();
    set.add(m.localCategoryId);
    myLocalBySc.set(m.sharedCategoryId, set);
  }
  const mySpend = await myCategorySpend(tx, dataKey, month);

  // Every member's published totals for the month, decrypted.
  const publishedRows = await tx
    .select()
    .from(publishedCategoryTotals)
    .where(
      and(
        eq(publishedCategoryTotals.householdId, householdId),
        eq(publishedCategoryTotals.month, monthKey),
      ),
    );
  const published = new Map<string, { amount: Decimal; asOf: string }>();
  for (const r of publishedRows) {
    const val = decText(groupKey, r.totalCt, r.id, "total_ct", r.version);
    if (val == null) continue;
    published.set(`${r.sharedCategoryId}:${r.memberId}`, {
      amount: new Decimal(val),
      asOf: r.publishedAt.toISOString(),
    });
  }

  const ceilingRows = await tx
    .select()
    .from(householdBudgetCeilings)
    .where(eq(householdBudgetCeilings.householdId, householdId));

  const categories: CombinedCategory[] = scs.map((sc) => {
    const myLive = liveFor(sc.id, myLocalBySc, mySpend);
    let combined = new Decimal(0);
    let provisional = false;
    const perMember: MemberFigure[] = members.map((memberId) => {
      if (memberId === userId) {
        combined = combined.plus(myLive);
        return {
          memberId,
          amount: myLive.toString(),
          asOf: null,
          isLive: true,
          notReported: false,
        };
      }
      const pub = published.get(`${sc.id}:${memberId}`);
      if (!pub) {
        provisional = true;
        return { memberId, amount: "0", asOf: null, isLive: false, notReported: true };
      }
      combined = combined.plus(pub.amount);
      return {
        memberId,
        amount: pub.amount.toString(),
        asOf: pub.asOf,
        isLive: false,
        notReported: false,
      };
    });

    return {
      sharedCategoryId: sc.id,
      name: sc.name,
      ceiling: effectiveCeiling(groupKey, ceilingRows, sc.id, monthKey),
      combined: combined.toString(),
      myFigure: myLive.toString(),
      perMember,
      provisional,
    };
  });

  return { categories, members };
}

/** My live spend for one shared category = sum over my mapped local categories. */
function liveFor(
  sharedCategoryId: string,
  myLocalBySc: Map<string, Set<string>>,
  mySpend: Map<string, Decimal>,
): Decimal {
  const locals = myLocalBySc.get(sharedCategoryId);
  let total = new Decimal(0);
  if (locals) for (const id of locals) total = total.plus(mySpend.get(id) ?? new Decimal(0));
  return total;
}

export interface HouseholdOverview {
  householdId: string;
  name: string;
  budget: HouseholdBudgetView;
  settlement: SettlementView;
}

/**
 * The combined budget + settlement for EVERY household the caller belongs to,
 * for a month — the aggregator the household-only MCP tools read. Empty when
 * the caller is in no household.
 */
export async function getHouseholdOverview(
  userId: string,
  dataKey: Buffer,
  month: string = currentMonth(),
): Promise<HouseholdOverview[]> {
  const memberships = await listMemberships(userId);
  const seen = new Set<string>();
  const out: HouseholdOverview[] = [];
  for (const m of memberships) {
    if (seen.has(m.householdId)) continue;
    seen.add(m.householdId);
    const budget = await getHouseholdBudget(userId, dataKey, m.householdId, month);
    const settlement = await getSettlement(userId, dataKey, m.householdId, month);
    if (budget && settlement) {
      out.push({ householdId: m.householdId, name: m.householdName, budget, settlement });
    }
  }
  return out;
}

export interface HouseholdMonthlyTotal {
  month: string;
  /** Combined household spend across all shared categories that month. */
  combined: string;
  /** Sum of the household ceilings in force that month, or null if none set. */
  ceiling: string | null;
}

/**
 * Combined household spend per month, for a small trailing window — the data
 * behind the household monthly bar chart. A pure read: loads the group key once
 * and sums each month's combined figures without republishing (unlike
 * getHouseholdBudget). Empty when the caller is in no household.
 */
export async function getHouseholdMonthlyTotals(
  userId: string,
  dataKey: Buffer,
  householdId: string,
  months: string[],
): Promise<HouseholdMonthlyTotal[]> {
  return withUser(userId, async (tx) => {
    const groupKey = await loadGroupKey(tx, householdId, dataKey);
    if (!groupKey) return [];
    try {
      const out: HouseholdMonthlyTotal[] = [];
      for (const month of months) {
        const built = await buildCombined(tx, userId, dataKey, groupKey, householdId, month);
        if (!built) {
          out.push({ month, combined: "0", ceiling: null });
          continue;
        }
        let combined = new Decimal(0);
        let ceiling = new Decimal(0);
        let anyCeiling = false;
        for (const c of built.categories) {
          combined = combined.plus(c.combined);
          if (c.ceiling !== null) {
            ceiling = ceiling.plus(c.ceiling);
            anyCeiling = true;
          }
        }
        out.push({
          month,
          combined: combined.toString(),
          ceiling: anyCeiling ? ceiling.toString() : null,
        });
      }
      return out;
    } finally {
      wipe(groupKey);
    }
  });
}

// --- Settlement -------------------------------------------------------------

export interface SettlementMember {
  memberId: string;
  /** weight × combined, rounded to agora (exact-string, 2 dp). */
  share: string;
  /** What this member paid (their contribution to the combined). */
  paid: string;
  /** paid − share, conserved so all nets sum to exactly zero. Positive = owed. */
  net: string;
}

export interface SettlementTransfer {
  from: string;
  to: string;
  /** Positive agora-rounded amount `from` transfers `to`. */
  amount: string;
}

export interface SettlementView {
  householdId: string;
  month: string;
  provisional: boolean;
  members: SettlementMember[];
  /** Netted single true-up per pair (one line for two members). */
  transfers: SettlementTransfer[];
  /** Per-category transparency breakdown. */
  perCategory: {
    sharedCategoryId: string;
    name: string;
    combined: string;
    members: { memberId: string; share: string; paid: string }[];
  }[];
}

/**
 * Settlement for a month: the combined figures read through the split weights.
 * Each member's share = weight × combined; they paid their own contribution;
 * the nets are netted across all shared categories into one true-up per pair
 * and conserved to exactly zero. Returns null if the caller is not a member.
 */
export async function getSettlement(
  userId: string,
  dataKey: Buffer,
  householdId: string,
  month: string = currentMonth(),
): Promise<SettlementView | null> {
  return withUser(userId, async (tx) => {
    await publishSharedTotalsInTx(tx, userId, dataKey, [month]);
    const groupKey = await loadGroupKey(tx, householdId, dataKey);
    if (!groupKey) return null;
    try {
      const built = await buildCombined(tx, userId, dataKey, groupKey, householdId, month);
      if (!built) return null;

      const splits = await tx
        .select()
        .from(sharedCategorySplits)
        .where(eq(sharedCategorySplits.householdId, householdId));
      const weightOf = (sc: string, member: string): Decimal => {
        const row = splits.find((s) => s.sharedCategoryId === sc && s.memberId === member);
        return row ? new Decimal(row.weight) : new Decimal(0);
      };

      // Exact paid and share per member, summed across categories.
      const paid = new Map<string, Decimal>();
      const share = new Map<string, Decimal>();
      for (const member of built.members) {
        paid.set(member, new Decimal(0));
        share.set(member, new Decimal(0));
      }
      const perCategory: SettlementView["perCategory"] = [];
      let provisional = false;
      for (const c of built.categories) {
        if (c.provisional) provisional = true;
        const combined = new Decimal(c.combined);
        const catMembers = c.perMember.map((m) => {
          const memberPaid = new Decimal(m.amount);
          const memberShare = combined.times(weightOf(c.sharedCategoryId, m.memberId));
          paid.set(m.memberId, paid.get(m.memberId)!.plus(memberPaid));
          share.set(m.memberId, share.get(m.memberId)!.plus(memberShare));
          return {
            memberId: m.memberId,
            share: memberShare.toDecimalPlaces(2).toFixed(2),
            paid: memberPaid.toFixed(2),
          };
        });
        perCategory.push({
          sharedCategoryId: c.sharedCategoryId,
          name: c.name,
          combined: combined.toFixed(2),
          members: catMembers,
        });
      }

      // Exact nets (paid − share) sum to exactly zero; conserve after rounding.
      const exactNet = new Map<string, Decimal>();
      for (const member of built.members) {
        exactNet.set(member, paid.get(member)!.minus(share.get(member)!));
      }
      const net = conserveNets(exactNet);

      const members: SettlementMember[] = built.members.map((memberId) => ({
        memberId,
        share: share.get(memberId)!.toDecimalPlaces(2).toFixed(2),
        paid: paid.get(memberId)!.toDecimalPlaces(2).toFixed(2),
        net: net.get(memberId)!.toFixed(2),
      }));

      return {
        householdId,
        month,
        provisional,
        members,
        transfers: transfersFromNets(net),
        perCategory,
      };
    } finally {
      wipe(groupKey);
    }
  });
}

/**
 * Rounds each member's exact net to agora and distributes the leftover so the
 * rounded nets still sum to EXACTLY zero. Deterministic rule: the residual
 * agora go to the members with the largest fractional remainder, tie-broken by
 * member id. Exact nets are assumed to sum to zero.
 */
export function conserveNets(exactNet: Map<string, Decimal>): Map<string, Decimal> {
  const rounded = new Map<string, Decimal>();
  let residualAgora = new Decimal(0);
  const frac: { memberId: string; remainder: Decimal }[] = [];
  for (const [memberId, exact] of exactNet) {
    const down = exact.times(100).floor().div(100); // floor to agora
    rounded.set(memberId, down);
    residualAgora = residualAgora.plus(exact.minus(down).times(100));
    frac.push({ memberId, remainder: exact.minus(down) });
  }
  // residualAgora is (near) an integer count of agora still to distribute.
  let toGive = Number(residualAgora.toDecimalPlaces(0).toString());
  frac.sort((a, b) => {
    const cmp = b.remainder.comparedTo(a.remainder);
    return cmp !== 0 ? cmp : a.memberId.localeCompare(b.memberId);
  });
  let i = 0;
  while (toGive > 0 && frac.length > 0) {
    const target = frac[i % frac.length].memberId;
    rounded.set(target, rounded.get(target)!.plus(new Decimal("0.01")));
    toGive -= 1;
    i += 1;
  }
  return rounded;
}

/**
 * Turns conserved nets into transfers. For two members it is one line: the ower
 * (negative net) pays the owed (positive net). N-way min-cash-flow is deferred
 * (issue #115), so more than two members yields per-member balances only.
 */
function transfersFromNets(net: Map<string, Decimal>): SettlementTransfer[] {
  const entries = [...net.entries()];
  if (entries.length !== 2) return [];
  const [[idA, netA], [idB, netB]] = entries;
  if (netA.isZero() && netB.isZero()) return [];
  // The member with the negative net owes the one with the positive net.
  if (netA.isNegative()) return [{ from: idA, to: idB, amount: netA.abs().toFixed(2) }];
  return [{ from: idB, to: idA, amount: netB.abs().toFixed(2) }];
}
