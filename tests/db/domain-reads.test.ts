// Domain-layer read tests: the read path the UI/MCP actually uses
// (listAccounts / listEntries) goes through withUser (RLS) AND decrypts
// Tier-1 fields with the session's data key. Asserts three things the UI
// depends on:
//   1. correct decryption of a user's own encrypted fields;
//   2. cross-tenant isolation at the domain layer (A's session never yields
//      B's rows — the RLS backstop, exercised through the real read fns);
//   3. reads require the *right* key — a wrong data key cannot decrypt.
// Fixtures are inserted with the same dev key provider + AAD the seed uses,
// so the ciphertext is honest (not the placeholder bytea rls-isolation uses).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@/db/schema";
import { encryptField, getDevUserDataKey, type AadContext } from "@/lib/crypto";
import { listAccounts } from "@/domain/accounts";
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
  accountId: string;
  entryId: string;
}

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
    accountType: "checking",
    classification: "asset",
    nameCt: enc(dataKey, accountId, "name_ct", `${label} Checking`),
    accountNumberLast4Ct: enc(dataKey, accountId, "account_number_last4_ct", "4821"),
    currentBalanceCt: enc(dataKey, accountId, "current_balance_ct", "1000.00"),
    currency: "ILS",
  });

  const entryId = randomUUID();
  await elevatedDb.insert(schema.entries).values({
    id: entryId,
    ownerId: userId,
    accountId,
    entryType: "transaction",
    date: "2026-07-10",
    descriptionCt: enc(dataKey, entryId, "description_ct", `${label} groceries`),
    status: "posted",
    enteredAmountCt: enc(dataKey, entryId, "entered_amount_ct", "-120.00"),
    enteredCurrency: "ILS",
    accountAmountCt: enc(dataKey, entryId, "account_amount_ct", "-120.00"),
    accountCurrency: "ILS",
    reportingCurrency: "ILS",
    fxRate: "1",
    fxRateDate: "2026-07-10",
    fxSource: "test",
    fxStatus: "locked",
    source: "manual",
  });

  return { userId, dataKey, accountId, entryId };
}

function sessionFor(f: Fixture, key: Uint8Array = f.dataKey): Session {
  return {
    id: "test-session",
    userId: f.userId,
    dataKey: Buffer.from(key),
    baseCurrency: "ILS",
    syncPromptDismissed: false,
    expiresAt: Date.now() + 3_600_000,
  };
}

describe("domain reads: decryption + cross-tenant isolation", () => {
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

  it("decrypts the owner's own account fields", async () => {
    const accounts = await listAccounts(sessionFor(userA));
    expect(accounts).toHaveLength(1);
    expect(accounts[0].name).toBe("a Checking");
    expect(accounts[0].last4).toBe("4821");
    expect(accounts[0].balance).toEqual({ amount: "1000.00", currency: "ILS" });
  });

  it("derives the reporting amount for an entry (entered × locked rate)", async () => {
    const entries = await listEntries(sessionFor(userA));
    expect(entries).toHaveLength(1);
    expect(entries[0].description).toBe("a groceries");
    // Reporting leg is entered × locked rate; decimal.js canonicalizes
    // "-120.00" × "1" to "-120" (same exact value; display pads minor units).
    expect(entries[0].amount).toEqual({ amount: "-120", currency: "ILS" });
    expect(entries[0].fxPending).toBe(false);
    expect(entries[0].accountName).toBe("a Checking");
  });

  it("cross-tenant: A's session never returns B's rows", async () => {
    const accounts = await listAccounts(sessionFor(userA));
    expect(accounts.map((a) => a.id)).toEqual([userA.accountId]);

    const entries = await listEntries(sessionFor(userA));
    expect(entries.map((e) => e.id)).toEqual([userA.entryId]);

    // And symmetrically for B.
    const bAccounts = await listAccounts(sessionFor(userB));
    expect(bAccounts.map((a) => a.id)).toEqual([userB.accountId]);
  });

  it("reads require the correct key: a wrong data key cannot decrypt", async () => {
    const wrongKey = getDevUserDataKey(randomUUID());
    await expect(listAccounts(sessionFor(userA, wrongKey))).rejects.toThrow();
  });
});
