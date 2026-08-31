// Combined household budget + settlement (issue #115), end to end with a seeded
// two-user household. Proves: combined = my live + partner's published; the
// "not yet reported" provisional state (never a silent ₪0); split-applied
// settlement that conserves to exactly zero; and the deterministic
// leftover-agora rule.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { eq } from "drizzle-orm";
import { withUser } from "@/db/client";
import { accounts, categories, entries } from "@/db/schema";
import { encText } from "@/domain/fields";
import { createUser } from "@/domain/registration";
import { acceptInvite, createHousehold, inviteMember } from "@/domain/household";
import {
  createSharedCategory,
  mapLocalCategory,
  setHouseholdCeiling,
  setSplit,
} from "@/domain/shared-categories";
import { publishSharedTotals } from "@/domain/household-publish";
import {
  conserveNets,
  getHouseholdBudget,
  getHouseholdMonthlyTotals,
  getSettlement,
} from "@/domain/household-budget";
import { cleanupHouseholds, cleanupOwners } from "./helpers";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN;
const MONTH = "2026-08";

let userA: string;
let dkA: Buffer;
let userB: string;
let dkB: Buffer;
let householdId: string;
let sharedCategoryId: string;

async function expenseCategoryOf(userId: string): Promise<string> {
  return withUser(userId, async (tx) => {
    const [c] = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.classification, "expense"))
      .limit(1);
    return c.id;
  });
}

async function seedSpend(userId: string, dataKey: Buffer, categoryId: string, amount: string) {
  const acctId = randomUUID();
  const entryId = randomUUID();
  await withUser(userId, async (tx) => {
    await tx.insert(accounts).values({
      id: acctId,
      ownerId: userId,
      accountType: "checking",
      classification: "asset",
      nameCt: encText(dataKey, "Checking", acctId, "name_ct", 1),
      currency: "ILS",
    });
    await tx.insert(entries).values({
      id: entryId,
      ownerId: userId,
      accountId: acctId,
      entryType: "transaction",
      date: `${MONTH}-08`,
      descriptionCt: encText(dataKey, "Shop", entryId, "description_ct", 1),
      categoryId,
      status: "posted",
      enteredAmountCt: encText(dataKey, amount, entryId, "entered_amount_ct", 1),
      enteredCurrency: "ILS",
      accountAmountCt: encText(dataKey, amount, entryId, "account_amount_ct", 1),
      accountCurrency: "ILS",
      reportingCurrency: "ILS",
      fxRate: "1",
      fxStatus: "locked",
      source: "manual",
    });
  });
}

beforeAll(async () => {
  ({ userId: userA, dataKey: dkA } = await createUser(
    `set-a-${randomUUID()}@test.moni`,
    Buffer.from("pw-a"),
    SIGNUP_TOKEN!,
  ));
  ({ userId: userB, dataKey: dkB } = await createUser(
    `set-b-${randomUUID()}@test.moni`,
    Buffer.from("pw-b"),
    SIGNUP_TOKEN!,
  ));
  ({ householdId } = await createHousehold(userA, dkA, "Home"));
  const invite = await inviteMember(userA, dkA, householdId);
  await acceptInvite(userB, dkB, invite.secret);
  ({ sharedCategoryId } = await createSharedCategory(userA, householdId, "Groceries"));

  const catA = await expenseCategoryOf(userA);
  const catB = await expenseCategoryOf(userB);
  await mapLocalCategory(userA, householdId, sharedCategoryId, catA);
  await mapLocalCategory(userB, householdId, sharedCategoryId, catB);
  await setSplit(userA, householdId, sharedCategoryId, [
    { memberId: userA, weight: "0.5" },
    { memberId: userB, weight: "0.5" },
  ]);
  await setHouseholdCeiling(userA, dkA, householdId, sharedCategoryId, "1000", MONTH, false);

  await seedSpend(userA, dkA, catA, "-300"); // A spends 300
  await seedSpend(userB, dkB, catB, "-500"); // B spends 500
});

afterAll(async () => {
  await cleanupHouseholds([householdId]);
  await cleanupOwners([userA, userB]);
});

describe("combined view", () => {
  it("is provisional and flags the partner as not-yet-reported before they publish", async () => {
    // A reads first, before B has ever published — never a silent 0 for B.
    const view = (await getHouseholdBudget(userA, dkA, householdId, MONTH))!;
    const cat = view.categories.find((c) => c.sharedCategoryId === sharedCategoryId)!;
    expect(view.provisional).toBe(true);
    expect(cat.myFigure).toBe("300");
    expect(cat.combined).toBe("300"); // only A's live figure so far
    const b = cat.perMember.find((m) => m.memberId === userB)!;
    expect(b.notReported).toBe(true);
    expect(b.asOf).toBeNull();
  });

  it("combines my live figure with the partner's published figure once both report", async () => {
    await publishSharedTotals(userB, dkB, [MONTH]);
    const view = (await getHouseholdBudget(userA, dkA, householdId, MONTH))!;
    const cat = view.categories.find((c) => c.sharedCategoryId === sharedCategoryId)!;
    expect(view.provisional).toBe(false);
    expect(cat.ceiling).toBe("1000");
    expect(cat.myFigure).toBe("300");
    expect(cat.combined).toBe("800"); // 300 live + 500 published
    const b = cat.perMember.find((m) => m.memberId === userB)!;
    expect(b.amount).toBe("500");
    expect(b.asOf).not.toBeNull();
  });
});

describe("settlement", () => {
  it("splits 50/50 and conserves to exactly zero (A pays B 100)", async () => {
    const s = (await getSettlement(userA, dkA, householdId, MONTH))!;
    expect(s.provisional).toBe(false);
    const a = s.members.find((m) => m.memberId === userA)!;
    const b = s.members.find((m) => m.memberId === userB)!;
    expect(a.share).toBe("400.00");
    expect(b.share).toBe("400.00");
    expect(a.net).toBe("-100.00");
    expect(b.net).toBe("100.00");
    // Nets sum to exactly zero.
    expect(new Decimal(a.net).plus(b.net).toFixed(2)).toBe("0.00");
    expect(s.transfers).toEqual([{ from: userA, to: userB, amount: "100.00" }]);
  });

  it("applies a 70/30 split (A pays B 260)", async () => {
    await setSplit(userA, householdId, sharedCategoryId, [
      { memberId: userA, weight: "0.7" },
      { memberId: userB, weight: "0.3" },
    ]);
    const s = (await getSettlement(userB, dkB, householdId, MONTH))!;
    const a = s.members.find((m) => m.memberId === userA)!;
    const b = s.members.find((m) => m.memberId === userB)!;
    expect(a.share).toBe("560.00"); // 0.7 * 800
    expect(b.share).toBe("240.00");
    expect(a.net).toBe("-260.00"); // paid 300 - share 560
    expect(b.net).toBe("260.00");
    expect(s.transfers).toEqual([{ from: userA, to: userB, amount: "260.00" }]);
  });
});

describe("monthly totals (household bar chart data)", () => {
  it("returns the combined household spend and ceiling per month", async () => {
    const totals = await getHouseholdMonthlyTotals(userA, dkA, householdId, [MONTH]);
    expect(totals).toHaveLength(1);
    expect(totals[0].month).toBe(MONTH);
    expect(totals[0].combined).toBe("800"); // A live 300 + B published 500
    expect(totals[0].ceiling).toBe("1000");
    expect(totals[0].withinBudget).toBe(true); // 800 <= 1000
  });

  it("returns an empty combined figure and no verdict for a month with no ceiling", async () => {
    const totals = await getHouseholdMonthlyTotals(userA, dkA, householdId, ["2020-01"]);
    expect(totals[0].combined).toBe("0");
    expect(totals[0].withinBudget).toBeNull();
  });

  it("marks a month over budget when combined exceeds the ceiling", async () => {
    // Drop the ceiling below the ₪800 combined for this month only.
    await setHouseholdCeiling(userA, dkA, householdId, sharedCategoryId, "500", MONTH, false);
    const totals = await getHouseholdMonthlyTotals(userA, dkA, householdId, [MONTH]);
    expect(totals[0].ceiling).toBe("500");
    expect(totals[0].withinBudget).toBe(false); // 800 > 500
  });
});

describe("conserveNets: deterministic leftover-agora rule", () => {
  it("keeps a sub-agora split summing to exactly zero", () => {
    // Two members whose exact nets are +/- half an agora.
    const net = conserveNets(
      new Map([
        ["aaaa", new Decimal("0.005")],
        ["bbbb", new Decimal("-0.005")],
      ]),
    );
    const sum = [...net.values()].reduce((acc, d) => acc.plus(d), new Decimal(0));
    expect(sum.toFixed(2)).toBe("0.00");
    // Every net lands on an agora boundary.
    for (const d of net.values()) {
      expect(d.times(100).mod(1).toNumber()).toBe(0);
    }
  });

  it("is stable when nets are already agora-aligned", () => {
    const net = conserveNets(
      new Map([
        ["aaaa", new Decimal("-100.00")],
        ["bbbb", new Decimal("100.00")],
      ]),
    );
    expect(net.get("aaaa")!.toFixed(2)).toBe("-100.00");
    expect(net.get("bbbb")!.toFixed(2)).toBe("100.00");
  });
});
