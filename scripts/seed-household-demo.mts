// DEV-ONLY browser-demo seed: two users sharing one household, with realistic
// shared-category spend, splits, ceilings and published totals — so the
// household UI can be driven live and screenshotted (issue #115). The group-key
// exchange is done here by calling the real domain handshake
// (createHousehold → inviteMember → acceptInvite) offline, exactly as a real
// invite would, so the DB ends up in a genuine post-exchange state.
//
// Run against an already-migrated database (e.g. moni_test):
//   DATABASE_URL=postgresql://moni_app:moni_app_dev_password@localhost:5432/moni_test \
//   MONI_SIGNUP_TOKEN=... npx tsx scripts/seed-household-demo.mts
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { withUser } from "@/db/client";
import { accounts, entries } from "@/db/schema";
import type { Session } from "@/lib/auth/session-store";
import { encText } from "@/domain/fields";
import { createUser } from "@/domain/registration";
import { createConnection } from "@/domain/connections";
import { createCategory } from "@/domain/categorization";
import { currentMonth } from "@/domain/budget";
import { acceptInvite, createHousehold, inviteMember } from "@/domain/household";
import {
  createSharedCategory,
  mapLocalCategory,
  setHouseholdCeiling,
  setSplit,
} from "@/domain/shared-categories";
import { publishSharedTotals } from "@/domain/household-publish";

const PASSWORD = "moni-demo";
const MONTH = currentMonth();
const token = process.env.MONI_SIGNUP_TOKEN;
if (!token) throw new Error("MONI_SIGNUP_TOKEN is required");

function sessionFor(userId: string, dataKey: Buffer): Session {
  return { id: randomUUID(), userId, dataKey, baseCurrency: "ILS" } as Session;
}

async function makeUser(email: string) {
  const { userId, dataKey } = await createUser(email, Buffer.from(PASSWORD), token!);
  // A connection is the "onboarding complete" signal (requireOnboarded).
  await createConnection(userId, "schwab_positions_csv", null, null, "Demo import");
  return { userId, dataKey, session: sessionFor(userId, dataKey) };
}

async function makeCategory(session: Session, name: string): Promise<string> {
  return createCategory(session, {
    name,
    parentId: null,
    classification: "expense",
    color: "chart-1",
    icon: "tag",
  });
}

async function seedEntry(
  userId: string,
  dataKey: Buffer,
  accountId: string,
  categoryId: string | null,
  amount: string,
  day: string,
) {
  const id = randomUUID();
  await withUser(userId, async (tx) => {
    await tx.insert(entries).values({
      id,
      ownerId: userId,
      accountId,
      entryType: "transaction",
      date: `${MONTH}-${day}`,
      descriptionCt: encText(dataKey, "Purchase", id, "description_ct", 1),
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
}

async function makeAccount(userId: string, dataKey: Buffer): Promise<string> {
  const id = randomUUID();
  await withUser(userId, async (tx) => {
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

async function main() {
  const suffix = Date.now().toString(36);
  const emailA = `alex.demo.${suffix}@moni.test`;
  const emailB = `sam.demo.${suffix}@moni.test`;

  const a = await makeUser(emailA);
  const b = await makeUser(emailB);

  const acctA = await makeAccount(a.userId, a.dataKey);
  const acctB = await makeAccount(b.userId, b.dataKey);

  // Each member's own local categories.
  const aGroceries = await makeCategory(a.session, "Groceries");
  const aDining = await makeCategory(a.session, "Dining out");
  const aSolo = await makeCategory(a.session, "Hobbies"); // personal, not shared
  const bGroceries = await makeCategory(b.session, "Groceries");
  const bDining = await makeCategory(b.session, "Restaurants");

  // The household (offline key exchange via the real handshake).
  const { householdId } = await createHousehold(a.userId, a.dataKey, "The Cohen Household");
  const invite = await inviteMember(a.userId, a.dataKey, householdId, { inviteeEmail: emailB });
  await acceptInvite(b.userId, b.dataKey, invite.secret);

  // Shared line 1: Groceries, 60/40, ceiling 3000. A spends 1200, B spends 1500.
  const groceries = (await createSharedCategory(a.userId, householdId, "Groceries"))
    .sharedCategoryId;
  await mapLocalCategory(a.userId, householdId, groceries, aGroceries);
  await mapLocalCategory(b.userId, householdId, groceries, bGroceries);
  await setSplit(a.userId, householdId, groceries, [
    { memberId: a.userId, weight: "0.6" },
    { memberId: b.userId, weight: "0.4" },
  ]);
  await setHouseholdCeiling(a.userId, a.dataKey, householdId, groceries, "3000", MONTH, false);

  // Shared line 2: Dining out, 50/50, ceiling 800. A 500, B 450 (over budget).
  const dining = (await createSharedCategory(a.userId, householdId, "Dining out")).sharedCategoryId;
  await mapLocalCategory(a.userId, householdId, dining, aDining);
  await mapLocalCategory(b.userId, householdId, dining, bDining);
  await setSplit(a.userId, householdId, dining, [
    { memberId: a.userId, weight: "0.5" },
    { memberId: b.userId, weight: "0.5" },
  ]);
  await setHouseholdCeiling(a.userId, a.dataKey, householdId, dining, "800", MONTH, false);

  // Ledger entries in the current month.
  await seedEntry(a.userId, a.dataKey, acctA, aGroceries, "-700", "04");
  await seedEntry(a.userId, a.dataKey, acctA, aGroceries, "-500", "18");
  await seedEntry(a.userId, a.dataKey, acctA, aDining, "-500", "12");
  await seedEntry(a.userId, a.dataKey, acctA, aSolo, "-260", "20"); // personal
  await seedEntry(b.userId, b.dataKey, acctB, bGroceries, "-900", "05");
  await seedEntry(b.userId, b.dataKey, acctB, bGroceries, "-600", "22");
  await seedEntry(b.userId, b.dataKey, acctB, bDining, "-450", "15");

  // Publish both members so the combined view is complete (not provisional).
  await publishSharedTotals(a.userId, a.dataKey, [MONTH]);
  await publishSharedTotals(b.userId, b.dataKey, [MONTH]);

  console.log(
    JSON.stringify(
      { month: MONTH, householdId, userA: emailA, userB: emailB, password: PASSWORD },
      null,
      2,
    ),
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
