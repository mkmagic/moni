// Shared categories, split weights, local→shared mapping, the group-owned
// household ceiling, and the per-user budget integration (issue #115). Two real
// users share one household; every call is the production domain path.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { withUser } from "@/db/client";
import { categories } from "@/db/schema";
import type { Session } from "@/lib/auth/session-store";
import { createUser } from "@/domain/registration";
import { acceptInvite, createHousehold, inviteMember } from "@/domain/household";
import {
  SharedCategoryError,
  createSharedCategory,
  listSharedCategories,
  mapLocalCategory,
  setHouseholdCeiling,
  setSplit,
  unmapLocalCategory,
} from "@/domain/shared-categories";
import { BudgetCategorySharedError, getBudgetMonth, setCeiling } from "@/domain/budget";
import { cleanupHouseholds, cleanupOwners } from "./helpers";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN;

let userA: string;
let dkA: Buffer;
let userB: string;
let dkB: Buffer;
let householdId: string;
let sharedCategoryId: string;
let catA: string; // an A-owned expense category
let sessionA: Session;

async function expenseCategoryOf(userId: string): Promise<string> {
  return withUser(userId, async (tx) => {
    const rows = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.classification, "expense"))
      .limit(1);
    return rows[0].id;
  });
}

beforeAll(async () => {
  ({ userId: userA, dataKey: dkA } = await createUser(
    `sc-a-${randomUUID()}@test.moni`,
    Buffer.from("pw-a"),
    SIGNUP_TOKEN!,
  ));
  ({ userId: userB, dataKey: dkB } = await createUser(
    `sc-b-${randomUUID()}@test.moni`,
    Buffer.from("pw-b"),
    SIGNUP_TOKEN!,
  ));
  sessionA = { id: randomUUID(), userId: userA, dataKey: dkA, baseCurrency: "ILS" } as Session;

  ({ householdId } = await createHousehold(userA, dkA, "Home"));
  const invite = await inviteMember(userA, dkA, householdId);
  await acceptInvite(userB, dkB, invite.secret);

  ({ sharedCategoryId } = await createSharedCategory(userA, householdId, "Groceries"));
  catA = await expenseCategoryOf(userA);
});

afterAll(async () => {
  await cleanupHouseholds([householdId]);
  await cleanupOwners([userA, userB]);
});

describe("split weights", () => {
  it("accepts a valid 50/50 split and reads it back", async () => {
    await setSplit(userA, householdId, sharedCategoryId, [
      { memberId: userA, weight: "0.5" },
      { memberId: userB, weight: "0.5" },
    ]);
    const views = await listSharedCategories(userA, dkA, householdId, "2026-08");
    const sc = views.find((v) => v.id === sharedCategoryId)!;
    expect(sc.splits).toHaveLength(2);
    expect(new Set(sc.splits.map((s) => s.weight))).toEqual(new Set(["0.5"]));
  });

  it("rejects a split that does not sum to 1", async () => {
    await expect(
      setSplit(userA, householdId, sharedCategoryId, [
        { memberId: userA, weight: "0.7" },
        { memberId: userB, weight: "0.7" },
      ]),
    ).rejects.toBeInstanceOf(SharedCategoryError);
  });

  it("rejects a split naming a non-member", async () => {
    await expect(
      setSplit(userA, householdId, sharedCategoryId, [
        { memberId: userA, weight: "0.5" },
        { memberId: randomUUID(), weight: "0.5" },
      ]),
    ).rejects.toBeInstanceOf(SharedCategoryError);
  });
});

describe("household ceiling (group-key encrypted, effective-dated)", () => {
  it("stores and reads back the ceiling in force for a month", async () => {
    await setHouseholdCeiling(userA, dkA, householdId, sharedCategoryId, "2000", "2026-08", false);
    // Either member can read it via the group key.
    const viewB = await listSharedCategories(userB, dkB, householdId, "2026-08");
    expect(viewB.find((v) => v.id === sharedCategoryId)!.ceiling).toBe("2000");
    // A month before it took effect shows no ceiling.
    const before = await listSharedCategories(userA, dkA, householdId, "2026-07");
    expect(before.find((v) => v.id === sharedCategoryId)!.ceiling).toBeNull();
  });

  it("lets the other member raise the ceiling from a later month", async () => {
    await setHouseholdCeiling(userB, dkB, householdId, sharedCategoryId, "2500", "2026-09", false);
    const aug = await listSharedCategories(userA, dkA, householdId, "2026-08");
    const sep = await listSharedCategories(userA, dkA, householdId, "2026-09");
    expect(aug.find((v) => v.id === sharedCategoryId)!.ceiling).toBe("2000");
    expect(sep.find((v) => v.id === sharedCategoryId)!.ceiling).toBe("2500");
  });
});

describe("per-user budget integration (personal OR shared, never both)", () => {
  it("refuses a personal ceiling on a mapped (shared) category", async () => {
    await mapLocalCategory(userA, householdId, sharedCategoryId, catA);
    await expect(
      setCeiling(sessionA, {
        categoryId: catA,
        amount: "500",
        effectiveFrom: "2026-08",
        rollover: false,
      }),
    ).rejects.toBeInstanceOf(BudgetCategorySharedError);
    await unmapLocalCategory(userA, householdId, sharedCategoryId, catA);
  });

  it("suppresses a pre-existing personal ceiling once the category is mapped, and restores it on unmap", async () => {
    // Budget it personally first (while unmapped).
    await setCeiling(sessionA, {
      categoryId: catA,
      amount: "500",
      effectiveFrom: "2026-08",
      rollover: false,
    });
    const before = await getBudgetMonth(sessionA, "2026-08");
    expect(before.fixed.rows.concat(before.everyday.rows).some((r) => r.categoryId === catA)).toBe(
      true,
    );

    // Mapping it suppresses the personal ceiling (not shown), without deleting.
    await mapLocalCategory(userA, householdId, sharedCategoryId, catA);
    const mapped = await getBudgetMonth(sessionA, "2026-08");
    expect(mapped.fixed.rows.concat(mapped.everyday.rows).some((r) => r.categoryId === catA)).toBe(
      false,
    );

    // Unmapping restores it — the row was never deleted.
    await unmapLocalCategory(userA, householdId, sharedCategoryId, catA);
    const restored = await getBudgetMonth(sessionA, "2026-08");
    expect(
      restored.fixed.rows.concat(restored.everyday.rows).some((r) => r.categoryId === catA),
    ).toBe(true);
  });
});
