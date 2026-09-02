// RLS for the household sharing layer (issue #115) — the group-owned class.
// Proves the "am I a member of this household?" predicate end to end against a
// live RLS-protected moni_test, and the two refinements on top of it:
//   * published_category_totals: any member READS every member's row, but
//     WRITES only their own (member_id = app.user_id);
//   * shared_category_maps: member-private (a member never sees the other's
//     maps), and the composite FK makes "map someone else's category"
//     impossible at the database.
//
// Fixtures are seeded via the elevated (superuser) pool — seeding two members'
// rows plus a non-member in one step is exactly what no RLS-subject role can
// do. Every assertion goes through the real withUser() so the policies, not a
// hand-rolled equivalent, are what's under test.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { withUser } from "@/db/client";
import * as schema from "@/db/schema";
import { cleanupHouseholds, cleanupOwners, elevatedDb } from "./helpers";

const ct = (s: string) => Buffer.from(s, "utf8");

let householdId: string;
let sharedCategoryId: string;
let userA: string;
let userB: string;
let userC: string; // non-member
let catA: string; // userA's local category
let catB: string; // userB's local category

beforeAll(async () => {
  const mkUser = async (label: string) => {
    const [u] = await elevatedDb
      .insert(schema.users)
      .values({ email: `${label}-${randomUUID()}@test.moni`, baseCurrency: "ILS" })
      .returning({ id: schema.users.id });
    return u.id;
  };
  userA = await mkUser("hh-a");
  userB = await mkUser("hh-b");
  userC = await mkUser("hh-c");

  const [ca] = await elevatedDb
    .insert(schema.categories)
    .values({ ownerId: userA, name: "a-groceries", classification: "expense" })
    .returning({ id: schema.categories.id });
  catA = ca.id;
  const [cb] = await elevatedDb
    .insert(schema.categories)
    .values({ ownerId: userB, name: "b-groceries", classification: "expense" })
    .returning({ id: schema.categories.id });
  catB = cb.id;

  const [h] = await elevatedDb
    .insert(schema.households)
    .values({ name: "The Household", createdBy: userA })
    .returning({ id: schema.households.id });
  householdId = h.id;

  for (const owner of [userA, userB]) {
    await elevatedDb.insert(schema.householdMembers).values({
      householdId,
      ownerId: owner,
      wrappedGroupKey: ct(`wrapped-${owner}`),
    });
  }

  const [sc] = await elevatedDb
    .insert(schema.sharedCategories)
    .values({ householdId, name: "Groceries", createdBy: userA })
    .returning({ id: schema.sharedCategories.id });
  sharedCategoryId = sc.id;

  for (const [owner, weight] of [
    [userA, "0.5"],
    [userB, "0.5"],
  ] as const) {
    await elevatedDb
      .insert(schema.sharedCategorySplits)
      .values({ householdId, sharedCategoryId, memberId: owner, weight });
  }

  await elevatedDb.insert(schema.householdBudgetCeilings).values({
    householdId,
    sharedCategoryId,
    amountCt: ct("2000"),
    effectiveFrom: "2026-08-01",
  });

  for (const owner of [userA, userB]) {
    await elevatedDb.insert(schema.publishedCategoryTotals).values({
      householdId,
      sharedCategoryId,
      memberId: owner,
      month: "2026-08-01",
      totalCt: ct(`total-${owner}`),
    });
  }

  // Each member maps their OWN local category onto the shared line.
  await elevatedDb
    .insert(schema.sharedCategoryMaps)
    .values({ householdId, sharedCategoryId, memberId: userA, localCategoryId: catA });
  await elevatedDb
    .insert(schema.sharedCategoryMaps)
    .values({ householdId, sharedCategoryId, memberId: userB, localCategoryId: catB });
});

afterAll(async () => {
  await cleanupHouseholds([householdId]);
  await cleanupOwners([userA, userB, userC]);
});

describe("household RLS: the member predicate", () => {
  it("lets a member read the household and its group-readable satellites", async () => {
    await withUser(userA, async (tx) => {
      expect(await tx.select().from(schema.households)).toHaveLength(1);
      expect(await tx.select().from(schema.sharedCategories)).toHaveLength(1);
      expect(await tx.select().from(schema.sharedCategorySplits)).toHaveLength(2);
      expect(await tx.select().from(schema.householdBudgetCeilings)).toHaveLength(1);
      // Both members' published totals are visible — that's how the combined
      // figure is assembled.
      expect(await tx.select().from(schema.publishedCategoryTotals)).toHaveLength(2);
    });
  });

  it("hides everything from a non-member (fail closed, zero rows)", async () => {
    await withUser(userC, async (tx) => {
      expect(await tx.select().from(schema.households)).toHaveLength(0);
      expect(await tx.select().from(schema.sharedCategories)).toHaveLength(0);
      expect(await tx.select().from(schema.sharedCategorySplits)).toHaveLength(0);
      expect(await tx.select().from(schema.householdBudgetCeilings)).toHaveLength(0);
      expect(await tx.select().from(schema.publishedCategoryTotals)).toHaveLength(0);
    });
  });

  it("keeps a member's own household_members row visible, not the co-member's", async () => {
    await withUser(userA, async (tx) => {
      const rows = await tx.select().from(schema.householdMembers);
      expect(rows).toHaveLength(1);
      expect(rows[0].ownerId).toBe(userA);
    });
  });
});

describe("household RLS: shared_category_maps are member-private", () => {
  it("shows a member only their own map, never the other member's", async () => {
    await withUser(userA, async (tx) => {
      const rows = await tx.select().from(schema.sharedCategoryMaps);
      expect(rows).toHaveLength(1);
      expect(rows[0].memberId).toBe(userA);
      expect(rows[0].localCategoryId).toBe(catA);
    });
    await withUser(userB, async (tx) => {
      const rows = await tx.select().from(schema.sharedCategoryMaps);
      expect(rows).toHaveLength(1);
      expect(rows[0].memberId).toBe(userB);
    });
  });
});

describe("household RLS: per-member write gating on published totals", () => {
  it("lets a member update their OWN published total", async () => {
    await withUser(userA, async (tx) => {
      const updated = await tx
        .update(schema.publishedCategoryTotals)
        .set({ totalCt: ct("999") })
        .where(
          and(
            eq(schema.publishedCategoryTotals.memberId, userA),
            eq(schema.publishedCategoryTotals.sharedCategoryId, sharedCategoryId),
          ),
        )
        .returning({ id: schema.publishedCategoryTotals.id });
      expect(updated).toHaveLength(1);
    });
  });

  it("refuses to write a published total for another member (WITH CHECK)", async () => {
    await expect(
      withUser(userA, async (tx) => {
        await tx.insert(schema.publishedCategoryTotals).values({
          householdId,
          sharedCategoryId,
          memberId: userB, // not me
          month: "2026-09-01",
          totalCt: ct("evil"),
        });
      }),
    ).rejects.toThrow();
  });

  it("cannot UPDATE the co-member's published total (own-only USING)", async () => {
    await withUser(userA, async (tx) => {
      const updated = await tx
        .update(schema.publishedCategoryTotals)
        .set({ totalCt: ct("tamper") })
        .where(eq(schema.publishedCategoryTotals.memberId, userB))
        .returning({ id: schema.publishedCategoryTotals.id });
      // RLS makes B's row invisible to A's UPDATE — zero rows affected.
      expect(updated).toHaveLength(0);
    });
  });
});

describe("household RLS: writes require membership", () => {
  it("refuses a non-member creating a shared category in the household", async () => {
    await expect(
      withUser(userC, async (tx) => {
        await tx
          .insert(schema.sharedCategories)
          .values({ householdId, name: "sneaky", createdBy: userC });
      }),
    ).rejects.toThrow();
  });

  it("refuses mapping a category the member does not own (composite FK)", async () => {
    await expect(
      withUser(userA, async (tx) => {
        await tx.insert(schema.sharedCategoryMaps).values({
          householdId,
          sharedCategoryId,
          memberId: userA,
          localCategoryId: catB, // userB's category
        });
      }),
    ).rejects.toThrow();
  });
});
