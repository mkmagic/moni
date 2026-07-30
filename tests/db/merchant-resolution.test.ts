// src/domain/merchants.ts — the writer that `merchants` never had
// (docs/adr/0005-*). Exercises the real path: withUser (RLS), Tier-1
// encryption of the match text, and dedupe in the domain layer, which is
// where it has to happen because randomized ciphertext makes a unique
// constraint impossible.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@/db/schema";
import { encryptField, getDevUserDataKey, type AadContext } from "@/lib/crypto";
import { withUser } from "@/db/client";
import { entries as entriesTable } from "@/db/schema";
import { resolveMerchants, type MerchantResolutionSummary } from "@/domain/merchants";
import { listEntries } from "@/domain/transactions";
import type { Session } from "@/lib/auth/session-store";
import { cleanupOwners, elevatedDb, elevatedPool } from "./helpers";

function enc(dataKey: Uint8Array, rowId: string, column: string, value: string): Buffer {
  const aad: AadContext = { rowId, column, version: 1 };
  return encryptField(dataKey, Buffer.from(value, "utf8"), aad);
}

interface Fixture {
  userId: string;
  dataKey: Uint8Array;
  session: Session;
}

/** Three distinct payees across six entries — see the assertions for why each is here. */
const DESCRIPTIONS = [
  "PAYPAL *NETFLIX", // catalog hit, via a card processor
  "NETFLIX", // catalog hit, different match text, SAME payee
  "PAYPAL *NETFLIX", // repeat of the first
  "ג'ופניקה תל אביב", // no catalog entry -> named after its own match text
  "ג'ופניקה תל אביב", // repeat
  "HOTEL TEL AVIV", // must NOT collapse into the cable company HOT
];

async function seedUser(label: string): Promise<Fixture> {
  const userId = randomUUID();
  const dataKey = getDevUserDataKey(userId);

  await elevatedDb
    .insert(schema.users)
    .values({ id: userId, email: `${label}-${randomUUID()}@test.moni`, baseCurrency: "ILS" });

  const accountId = randomUUID();
  await elevatedDb.insert(schema.accounts).values({
    id: accountId,
    ownerId: userId,
    accountType: "credit_card",
    classification: "liability",
    nameCt: enc(dataKey, accountId, "name_ct", `${label} Card`),
    currentBalanceCt: enc(dataKey, accountId, "current_balance_ct", "-500.00"),
    currency: "ILS",
  });

  for (const [i, description] of DESCRIPTIONS.entries()) {
    const entryId = randomUUID();
    await elevatedDb.insert(schema.entries).values({
      id: entryId,
      ownerId: userId,
      accountId,
      entryType: "transaction",
      date: `2026-0${(i % 3) + 5}-0${(i % 9) + 1}`,
      descriptionCt: enc(dataKey, entryId, "description_ct", description),
      status: "posted",
      enteredAmountCt: enc(dataKey, entryId, "entered_amount_ct", "-49.90"),
      enteredCurrency: "ILS",
      accountAmountCt: enc(dataKey, entryId, "account_amount_ct", "-49.90"),
      accountCurrency: "ILS",
      reportingCurrency: "ILS",
      fxRate: "1",
      fxRateDate: `2026-0${(i % 3) + 5}-0${(i % 9) + 1}`,
      fxSource: "test",
      fxStatus: "locked",
      source: "scrape",
    });
  }

  const session: Session = {
    id: "test-session",
    userId,
    dataKey: Buffer.from(dataKey),
    baseCurrency: "ILS",
    promptSyncOnLogin: false,
    expiresAt: Date.now() + 3_600_000,
  };
  return { userId, dataKey, session };
}

/** Merchant names as seen through the read the UI actually uses. */
async function merchantNames(session: Session): Promise<(string | null)[]> {
  return (await listEntries(session)).map((e) => e.merchantName);
}

/**
 * Drives the real seam the way sync promotion does — inside one `withUser`
 * transaction, over a batch of entry ids. Sync passes the ids it just
 * touched; here it is every entry the user has.
 */
async function resolveAll(f: Fixture): Promise<MerchantResolutionSummary> {
  return withUser(f.userId, async (tx) => {
    const rows = await tx.select({ id: entriesTable.id }).from(entriesTable);
    return resolveMerchants(
      tx,
      f.userId,
      f.dataKey,
      rows.map((r) => r.id),
    );
  });
}

describe("merchant resolution", () => {
  let userA: Fixture;
  let userB: Fixture;

  beforeAll(async () => {
    userA = await seedUser("a");
    userB = await seedUser("b");
  });

  afterAll(async () => {
    await cleanupOwners([userA.userId, userB.userId]);
    await elevatedPool.end();
  });

  it("creates one merchant per distinct payee and links every entry", async () => {
    const result = await resolveAll(userA);
    // Six entries, three payees: Netflix (twice over, two spellings),
    // ג'ופניקה, and the hotel.
    expect(result.merchantsCreated).toBe(3);
    expect(result.entriesLinked).toBe(6);
  });

  it("gives a catalog payee its real name across every bank string it arrives as", async () => {
    // "paypal netflix" and "netflix" are different match texts, and the count
    // above proves they became ONE merchant: identity is the catalog entry
    // when there is one, the match text when there isn't (docs/adr/0005-*).
    const entries = await listEntries(userA.session);
    const netflix = entries.filter((e) => e.merchantName === "Netflix");
    expect(netflix).toHaveLength(3);
    expect(new Set(netflix.map((e) => e.matchText)).size).toBe(2);
  });

  it("names an unknown payee after its own match text", async () => {
    const names = await merchantNames(userA.session);
    // normalizeDescription strips the geresh, so this is the normalized form.
    expect(names).toContain("גופניקה תל אביב");
  });

  it("does not fold a hotel into the cable company HOT", async () => {
    const names = await merchantNames(userA.session);
    expect(names).toContain("hotel tel aviv");
    expect(names).not.toContain("HOT");
  });

  it("is idempotent — a second run creates nothing and links nothing", async () => {
    const again = await resolveAll(userA);
    expect(again).toEqual({ merchantsCreated: 0, entriesLinked: 0 });
  });

  it("never reaches across tenants — B's entries are untouched by A's run", async () => {
    expect(await merchantNames(userB.session)).toEqual(DESCRIPTIONS.map(() => null));

    const bResult = await resolveAll(userB);
    expect(bResult.merchantsCreated).toBe(3);
    expect(await merchantNames(userB.session)).not.toContain(null);
  });
});
