// Published running totals (Option A) + the re-categorization republish trigger
// (issue #115). Two real users share a household; each maps a local category
// onto the shared line and has real (DK-encrypted) entries. We prove each
// member's published number equals their own spend, that it is stored under the
// GROUP key (the other member can read it), and that re-categorizing a charge
// republishes synchronously.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { withUser } from "@/db/client";
import { categories, entries, publishedCategoryTotals } from "@/db/schema";
import type { Session } from "@/lib/auth/session-store";
import { decText, encText } from "@/domain/fields";
import { createUser } from "@/domain/registration";
import { setEntryCategory } from "@/domain/categorization";
import { acceptInvite, createHousehold, inviteMember, loadGroupKey } from "@/domain/household";
import { createSharedCategory, mapLocalCategory } from "@/domain/shared-categories";
import { publishSharedTotals } from "@/domain/household-publish";
import { cleanupHouseholds, cleanupOwners } from "./helpers";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN;
const MONTH = "2026-08";

let userA: string;
let dkA: Buffer;
let userB: string;
let dkB: Buffer;
let sessionA: Session;
let householdId: string;
let sharedCategoryId: string;
let catA: string;
let catB: string;

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

/** Inserts a real (DK-encrypted, FX-locked ILS) expense entry for a user. */
async function seedEntry(
  userId: string,
  dataKey: Buffer,
  accountId: string,
  categoryId: string | null,
  amount: string,
  date: string,
): Promise<string> {
  const id = randomUUID();
  await withUser(userId, async (tx) => {
    await tx.insert(entries).values({
      id,
      ownerId: userId,
      accountId,
      entryType: "transaction",
      date,
      descriptionCt: encText(dataKey, "Shop", id, "description_ct", 1),
      categoryId,
      status: "posted",
      enteredAmountCt: encText(dataKey, amount, id, "entered_amount_ct", 1),
      enteredCurrency: "ILS",
      accountAmountCt: encText(dataKey, amount, id, "account_amount_ct", 1),
      accountCurrency: "ILS",
      reportingCurrency: "ILS",
      fxRate: "1",
      fxStatus: "locked",
      source: "manual",
    });
  });
  return id;
}

async function seedAccount(userId: string, dataKey: Buffer): Promise<string> {
  const id = randomUUID();
  await withUser(userId, async (tx) => {
    const { accounts } = await import("@/db/schema");
    await tx.insert(accounts).values({
      id,
      ownerId: userId,
      accountType: "checking",
      classification: "asset",
      nameCt: encText(dataKey, "Checking", id, "name_ct", 1),
      currency: "ILS",
    });
  });
  return id;
}

/** Reads a member's published total for the shared line/month, decrypted. */
async function publishedTotalOf(
  userId: string,
  dataKey: Buffer,
  memberId: string,
): Promise<string | null> {
  return withUser(userId, async (tx) => {
    const groupKey = await loadGroupKey(tx, householdId, dataKey);
    if (!groupKey) return null;
    const [row] = await tx
      .select()
      .from(publishedCategoryTotals)
      .where(
        and(
          eq(publishedCategoryTotals.sharedCategoryId, sharedCategoryId),
          eq(publishedCategoryTotals.memberId, memberId),
          eq(publishedCategoryTotals.month, `${MONTH}-01`),
        ),
      );
    if (!row) return null;
    return decText(groupKey, row.totalCt, row.id, "total_ct", row.version);
  });
}

beforeAll(async () => {
  ({ userId: userA, dataKey: dkA } = await createUser(
    `pub-a-${randomUUID()}@test.moni`,
    Buffer.from("pw-a"),
    SIGNUP_TOKEN!,
  ));
  ({ userId: userB, dataKey: dkB } = await createUser(
    `pub-b-${randomUUID()}@test.moni`,
    Buffer.from("pw-b"),
    SIGNUP_TOKEN!,
  ));
  sessionA = { id: randomUUID(), userId: userA, dataKey: dkA, baseCurrency: "ILS" } as Session;

  ({ householdId } = await createHousehold(userA, dkA, "Home"));
  const invite = await inviteMember(userA, dkA, householdId);
  await acceptInvite(userB, dkB, invite.secret);
  ({ sharedCategoryId } = await createSharedCategory(userA, householdId, "Groceries"));

  catA = await expenseCategoryOf(userA);
  catB = await expenseCategoryOf(userB);
  await mapLocalCategory(userA, householdId, sharedCategoryId, catA);
  await mapLocalCategory(userB, householdId, sharedCategoryId, catB);

  const acctA = await seedAccount(userA, dkA);
  const acctB = await seedAccount(userB, dkB);
  await seedEntry(userA, dkA, acctA, catA, "-300", `${MONTH}-05`);
  await seedEntry(userB, dkB, acctB, catB, "-450", `${MONTH}-10`);
  // An A entry OUTSIDE the mapped category — must not count toward the shared line.
  await seedEntry(userA, dkA, acctA, null, "-70", `${MONTH}-12`);
});

afterAll(async () => {
  await cleanupHouseholds([householdId]);
  await cleanupOwners([userA, userB]);
});

describe("published running totals", () => {
  it("publishes each member's own spend under the group key", async () => {
    await publishSharedTotals(userA, dkA, [MONTH]);
    await publishSharedTotals(userB, dkB, [MONTH]);

    // A's mapped spend is 300 (the uncategorized 70 does not count).
    expect(await publishedTotalOf(userA, dkA, userA)).toBe("300");
    // B can read A's published total via the SAME group key — that's the point.
    expect(await publishedTotalOf(userB, dkB, userA)).toBe("300");
    // B's own is 450, readable by A too.
    expect(await publishedTotalOf(userB, dkB, userB)).toBe("450");
    expect(await publishedTotalOf(userA, dkA, userB)).toBe("450");
  });

  it("recompute-and-overwrites idempotently (value stable, version bumps)", async () => {
    const before = await withUser(userA, async (tx) => {
      const [r] = await tx
        .select({ version: publishedCategoryTotals.version })
        .from(publishedCategoryTotals)
        .where(
          and(
            eq(publishedCategoryTotals.memberId, userA),
            eq(publishedCategoryTotals.sharedCategoryId, sharedCategoryId),
          ),
        );
      return r.version;
    });
    await publishSharedTotals(userA, dkA, [MONTH]);
    const after = await withUser(userA, async (tx) => {
      const [r] = await tx
        .select({ version: publishedCategoryTotals.version })
        .from(publishedCategoryTotals)
        .where(
          and(
            eq(publishedCategoryTotals.memberId, userA),
            eq(publishedCategoryTotals.sharedCategoryId, sharedCategoryId),
          ),
        );
      return r.version;
    });
    expect(after).toBe(before + 1);
    expect(await publishedTotalOf(userA, dkA, userA)).toBe("300");
  });

  it("re-categorizing a charge into the shared line republishes synchronously", async () => {
    const acctA = await seedAccount(userA, dkA);
    const entryId = await seedEntry(userA, dkA, acctA, null, "-100", `${MONTH}-20`);

    // Moving the uncategorized -100 into the mapped category lifts A to 400.
    await setEntryCategory(sessionA, entryId, catA);
    expect(await publishedTotalOf(userA, dkA, userA)).toBe("400");

    // Moving it back out drops A back to 300 — the trigger fires both ways.
    await setEntryCategory(sessionA, entryId, null);
    expect(await publishedTotalOf(userA, dkA, userA)).toBe("300");
  });
});
