// deleteAccount() (src/domain/account-deletion.ts) — issue #31.
//
// This is the most destructive operation in the app, so the tests are
// written around the failure the issue names explicitly: deleting one user
// must not remove another user's data. Two fully-populated users are seeded
// and only one is deleted; every assertion below is a count comparison
// across BOTH of them.
//
// The table list the assertions iterate is read from
// `information_schema` at run time, not hand-maintained here. That is
// deliberate: a future migration that adds an owner-scoped table without
// teaching `deleteAccount()` about it must fail this suite rather than
// silently leave a user's rows behind. `fx_rates` is the sole table with no
// `owner_id` (global reference data — data-model.md §2/§5) and is therefore
// absent from the list for the same structural reason the app excludes it
// from RLS.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import * as schema from "@/db/schema";
import { deleteAccount } from "@/domain/account-deletion";
import { authenticate } from "@/domain/auth";
import { createUser } from "@/domain/registration";
import { destroySession, getSession } from "@/lib/auth/session-store";
import { cleanupOwners, elevatedDb, elevatedPool } from "./helpers";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN;
if (!SIGNUP_TOKEN) {
  throw new Error("MONI_SIGNUP_TOKEN must be set in the test environment (see .env.example)");
}

const PASSWORD = "correct horse battery staple";

// Fixture bytea placeholders — these tests assert row *existence*, not
// encryption correctness (crypto.test.ts owns that), and arbitrary non-null
// bytea satisfies the NOT NULL ciphertext columns.
const ct = (s: string) => Buffer.from(s, "utf8");

const freshEmail = (label: string) => `${label}-${randomUUID()}@test.moni`;

interface OwnerFixture {
  userId: string;
  email: string;
}

/**
 * Seeds one row in every owner-scoped table for a new user. The user itself
 * (and its `user_unlock_methods` password row) comes from the real
 * `createUser()` path, because the delete flow verifies a password and a
 * hand-rolled unlock row could not be verified. Everything else is seeded
 * through the elevated pool — seeding two owners is exactly what no
 * RLS-subject role can do (tests/db/helpers.ts).
 */
async function seedFullOwner(label: string): Promise<OwnerFixture> {
  const email = freshEmail(label);
  const { userId, dataKey } = await createUser(email, Buffer.from(PASSWORD, "utf8"), SIGNUP_TOKEN!);
  dataKey.fill(0); // not needed here; the fixtures use placeholder ciphertext

  const [connection] = await elevatedDb
    .insert(schema.connections)
    .values({
      ownerId: userId,
      connectorId: "leumi",
      displayName: `${label}-connection`,
      credentialsCt: ct(`${label}-creds`),
      status: "active",
    })
    .returning({ id: schema.connections.id });

  const [account] = await elevatedDb
    .insert(schema.accounts)
    .values({
      ownerId: userId,
      connectionId: connection.id,
      accountType: "credit_card",
      classification: "liability",
      nameCt: ct(`${label}-account`),
      currency: "ILS",
    })
    .returning({ id: schema.accounts.id });

  const [investmentAccount] = await elevatedDb
    .insert(schema.accounts)
    .values({
      ownerId: userId,
      connectionId: connection.id,
      accountType: "investment",
      classification: "asset",
      nameCt: ct(`${label}-investment-account`),
      currency: "USD",
      currentBalanceCt: null,
    })
    .returning({ id: schema.accounts.id });

  const [instrument] = await elevatedDb
    .insert(schema.instruments)
    .values({
      ownerId: userId,
      kind: "etf",
      canonicalNameCt: ct(`${label}-investment-name`),
      canonicalSymbolCt: ct(`${label}-investment-symbol`),
    })
    .returning({ id: schema.instruments.id });

  const [mapping] = await elevatedDb
    .insert(schema.instrumentSourceMappings)
    .values({
      ownerId: userId,
      instrumentId: instrument.id,
      provider: "tiingo",
      identifierKind: "isin",
      providerIdentifierCt: ct(`${label}-investment-id`),
      currency: "USD",
    })
    .returning({ id: schema.instrumentSourceMappings.id });

  await elevatedDb.insert(schema.investmentMarketQuotes).values({
    ownerId: userId,
    instrumentId: instrument.id,
    instrumentSourceMappingId: mapping.id,
    provider: "tiingo",
    providerSymbolCt: ct(`${label}-quote-symbol`),
    priceCt: ct("100.00"),
    currency: "USD",
    sourceDate: "2026-01-31",
    fetchedAt: new Date("2026-01-31T12:00:00Z"),
    splitState: "safe",
    qualityState: "accepted",
  });

  await elevatedDb.insert(schema.creditCardDetails).values({
    ownerId: userId,
    accountId: account.id,
    statementCloseDay: 10,
    paymentDueDay: 15,
  });

  await elevatedDb.insert(schema.accountBalanceSnapshots).values({
    ownerId: userId,
    accountId: account.id,
    date: "2026-01-31",
    nativeBalanceCt: ct("-1200.00"),
    currency: "ILS",
    source: "manual",
  });

  const [category] = await elevatedDb
    .insert(schema.categories)
    .values({ ownerId: userId, name: `${label}-groceries`, classification: "expense" })
    .returning({ id: schema.categories.id });

  const [merchant] = await elevatedDb
    .insert(schema.merchants)
    .values({
      ownerId: userId,
      nameCt: ct(`${label}-merchant`),
      matchTextCt: ct(`${label}-match`),
    })
    .returning({ id: schema.merchants.id });

  const entryValues = (suffix: string) => ({
    ownerId: userId,
    accountId: account.id,
    entryType: "transaction" as const,
    date: "2026-01-15",
    descriptionCt: ct(`${label}-entry-${suffix}`),
    categoryId: category.id,
    merchantId: merchant.id,
    status: "posted" as const,
    enteredAmountCt: ct("100.00"),
    enteredCurrency: "ILS",
    accountAmountCt: ct("100.00"),
    accountCurrency: "ILS",
    reportingCurrency: "ILS",
    fxStatus: "locked" as const,
    source: "manual" as const,
  });

  // Two entries so `transfers` — which holds two FKs into `entries` — can be
  // seeded with a real pair rather than the same row twice.
  const [inflow] = await elevatedDb
    .insert(schema.entries)
    .values(entryValues("in"))
    .returning({ id: schema.entries.id });
  const [outflow] = await elevatedDb
    .insert(schema.entries)
    .values(entryValues("out"))
    .returning({ id: schema.entries.id });

  await elevatedDb.insert(schema.entryTransactions).values({
    ownerId: userId,
    entryId: inflow.id,
    kind: "standard",
  });

  await elevatedDb.insert(schema.entryFieldChangelog).values({
    ownerId: userId,
    entryId: inflow.id,
    fieldName: "category_id",
    source: "user",
    valueCt: ct(category.id),
  });

  await elevatedDb.insert(schema.transfers).values({
    ownerId: userId,
    inflowEntryId: inflow.id,
    outflowEntryId: outflow.id,
    status: "confirmed",
  });

  await elevatedDb.insert(schema.categoryRejections).values({
    ownerId: userId,
    categoryId: category.id,
    matchTextCt: ct(`${label}-rejected`),
  });

  await elevatedDb.insert(schema.budgetCeilings).values({
    ownerId: userId,
    categoryId: category.id,
    amountCt: ct("-2000"),
    effectiveFrom: "2026-01-01",
  });

  await elevatedDb.insert(schema.budgetIncomes).values({
    ownerId: userId,
    amountCt: ct("18000"),
    effectiveFrom: "2026-01-01",
  });

  await elevatedDb.insert(schema.merchantLookups).values({
    ownerId: userId,
    matchTextCt: ct(`${label}-lookup`),
    builtinKey: "food-groceries",
    confidence: "high",
    model: "test-model",
    promptVersion: 1,
  });

  const [rule] = await elevatedDb
    .insert(schema.rules)
    .values({ ownerId: userId, name: `${label}-rule`, resourceType: "entry" })
    .returning({ id: schema.rules.id });

  await elevatedDb.insert(schema.ruleConditions).values({
    ownerId: userId,
    ruleId: rule.id,
    conditionType: "description",
    operator: "contains",
    valueCt: ct(`${label}-match`),
  });

  await elevatedDb.insert(schema.ruleActions).values({
    ownerId: userId,
    ruleId: rule.id,
    actionType: "set_category",
    value: category.id,
  });

  const [syncRun] = await elevatedDb
    .insert(schema.syncRuns)
    .values({ ownerId: userId, connectionId: connection.id, status: "succeeded" })
    .returning({ id: schema.syncRuns.id });

  await elevatedDb.transaction(async (tx) => {
    const [snapshot] = await tx
      .insert(schema.accountBalanceSnapshots)
      .values({
        ownerId: userId,
        accountId: investmentAccount.id,
        date: "2026-01-31",
        nativeBalanceCt: null,
        currency: null,
        source: "investment",
      })
      .returning({ id: schema.accountBalanceSnapshots.id });

    const [detail] = await tx
      .insert(schema.investmentSnapshotDetails)
      .values({
        ownerId: userId,
        accountBalanceSnapshotId: snapshot.id,
        accountId: investmentAccount.id,
        connectionId: connection.id,
        syncRunId: syncRun.id,
        weekStart: "2026-01-25",
        source: "ibkr_flex",
        sourceAsOf: new Date("2026-01-31T12:00:00Z"),
        sourceAsOfPrecision: "timestamp",
        brokerTotalCt: ct("100.00"),
        brokerTotalCurrency: "USD",
        reconciliationState: "matched",
        validationVersion: 1,
      })
      .returning({ id: schema.investmentSnapshotDetails.id });

    await tx.insert(schema.investmentSnapshotPositions).values({
      ownerId: userId,
      snapshotId: detail.id,
      instrumentId: instrument.id,
      quantityCt: ct("1"),
      quantityUnit: "shares",
      currency: "USD",
      sourceValueCt: ct("100.00"),
      sourceValueCurrency: "USD",
      brokerValuationBasis: "market_value",
    });
    await tx.insert(schema.investmentSnapshotCashBalances).values({
      ownerId: userId,
      snapshotId: detail.id,
      currency: "USD",
      amountCt: ct("0"),
    });
    await tx.insert(schema.investmentSourceEvidence).values({
      ownerId: userId,
      connectionId: connection.id,
      syncRunId: syncRun.id,
      accountId: investmentAccount.id,
      source: "ibkr_flex",
      sourceAsOf: new Date("2026-01-31T12:00:00Z"),
      sourceAsOfPrecision: "timestamp",
      validationVersion: 1,
      positionRowCount: 1,
      cashRowCount: 1,
      qualityCodes: [],
      normalizedFingerprint: ct(`${label}-fingerprint`),
    });
  });

  await elevatedDb.insert(schema.syncStaging).values({
    ownerId: userId,
    syncRunId: syncRun.id,
    accountId: account.id,
    rawPayloadCt: ct(`${label}-payload`),
    importKey: `${label}-import-key`,
    scraperStatus: "completed",
    promotedEntryId: inflow.id,
  });

  await elevatedDb.transaction(async (tx) => {
    const [savingsAccount] = await tx
      .insert(schema.accounts)
      .values({
        ownerId: userId,
        accountType: "long_term_savings",
        classification: "asset",
        connectionId: connection.id,
        nameCt: ct(`${label}-pension`),
        currency: "ILS",
        status: "active",
      })
      .returning({ id: schema.accounts.id });

    await tx.insert(schema.longTermSavingsDetails).values({
      ownerId: userId,
      accountId: savingsAccount.id,
      product: "pension",
      liquidity: "locked_retirement",
    });

    const [balance] = await tx
      .insert(schema.accountBalanceSnapshots)
      .values({
        ownerId: userId,
        accountId: savingsAccount.id,
        date: "2026-03-31",
        nativeBalanceCt: ct("76243"),
        currency: "ILS",
        source: "long_term_savings",
      })
      .returning({ id: schema.accountBalanceSnapshots.id });

    const [snapshot] = await tx
      .insert(schema.longTermSavingsSnapshots)
      .values({
        ownerId: userId,
        accountBalanceSnapshotId: balance.id,
        accountId: savingsAccount.id,
        connectionId: connection.id,
        syncRunId: syncRun.id,
        asOf: "2026-03-31",
        statedPeriodStart: "2026-01-01",
        statedPeriodEnd: "2026-03-31",
        currency: "ILS",
        closingBalanceCt: ct("76243"),
        openingBalanceCt: ct("72306"),
        contributionsCt: ct("7076"),
        investmentResultCt: ct("-2954"),
        feesChargedCt: ct("0"),
        insuranceDisabilityCt: ct("-131"),
        insuranceDeathCt: ct("-53"),
        balanceDriftCt: ct("1"),
        checkResultsCt: ct("[]"),
        parserId: "harel_pension_quarterly",
        parserVersion: 1,
      })
      .returning({ id: schema.longTermSavingsSnapshots.id });

    await tx.insert(schema.longTermSavingsSnapshotDeposits).values({
      ownerId: userId,
      snapshotId: snapshot.id,
      rowIndex: 0,
      depositDate: "2026-01-01",
      forMonth: "2025-12",
      employeeCt: ct("729"),
      employerContributionCt: ct("781"),
      severanceCt: ct("625"),
      totalCt: ct("2135"),
    });

    await tx.insert(schema.longTermSavingsSnapshotTracks).values({
      ownerId: userId,
      snapshotId: snapshot.id,
      rowIndex: 0,
      nameCt: ct(`${label}-track`),
      returnPct: "-3.81",
      annualCostPct: "0.10",
    });
  });

  // Agent token (issue #113). Placeholder hash + ciphertext — the delete test
  // only cares that the row exists and is removed, not that it verifies.
  const agentTokenId = randomUUID();
  await elevatedDb.insert(schema.agentTokens).values({
    id: agentTokenId,
    ownerId: userId,
    tokenHash: randomBytes(32),
    wrappedDk: ct(`${label}-token`),
    label: `${label}-agent`,
    expiresAt: new Date("2030-01-01T00:00:00Z"),
  });

  // Agent access log (issue #113 Phase 4) — a child of the token row.
  await elevatedDb.insert(schema.agentAccessLog).values({
    ownerId: userId,
    tokenId: agentTokenId,
    tool: "whoami",
    argShape: {},
    rowCount: 1,
  });

  return { userId, email };
}

/**
 * Every base table in `public` carrying an `owner_id`, discovered from the
 * catalog rather than listed by hand — see the file header for why.
 */
async function ownerScopedTables(): Promise<string[]> {
  const { rows } = await elevatedPool.query<{ table_name: string }>(
    `SELECT c.table_name
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public'
        AND c.column_name = 'owner_id'
        AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name`,
  );
  return rows.map((r) => r.table_name);
}

/** Row counts per owner-scoped table for `userId`, plus its own `users` row. */
async function rowCounts(userId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of await ownerScopedTables()) {
    const { rows } = await elevatedPool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "${table}" WHERE owner_id = $1::uuid`,
      [userId],
    );
    counts[table] = Number(rows[0].n);
  }
  const { rows } = await elevatedPool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM "users" WHERE id = $1::uuid`,
    [userId],
  );
  counts.users = Number(rows[0].n);
  return counts;
}

describe("deleteAccount(): removes one user completely and no one else at all", () => {
  let victim: OwnerFixture;
  let bystander: OwnerFixture;
  let bystanderCountsBefore: Record<string, number>;
  const createdUserIds: string[] = [];
  const createdSessionIds: string[] = [];

  beforeAll(async () => {
    victim = await seedFullOwner("victim");
    bystander = await seedFullOwner("bystander");
    createdUserIds.push(victim.userId, bystander.userId);
    bystanderCountsBefore = await rowCounts(bystander.userId);
  });

  afterAll(async () => {
    for (const id of createdSessionIds) destroySession(id);
    await cleanupOwners(createdUserIds);
    await elevatedPool.end();
  });

  it("seeds a row in every owner-scoped table, so the deletion assertions are meaningful", async () => {
    // Guards the suite itself: if a table were empty before the delete,
    // "zero rows afterwards" would prove nothing about it.
    const tables = await ownerScopedTables();
    expect(tables.length).toBeGreaterThan(0);
    for (const [table, n] of Object.entries(bystanderCountsBefore)) {
      expect(n, `${table} should have at least one fixture row`).toBeGreaterThan(0);
    }
    // Every table the catalog knows about must be covered by the fixture.
    expect(Object.keys(bystanderCountsBefore).sort()).toEqual([...tables, "users"].sort());
  });

  it("refuses a wrong password and deletes nothing", async () => {
    const result = await deleteAccount(victim.userId, Buffer.from("wrong password", "utf8"));
    expect(result).toBe("invalid-password");

    const counts = await rowCounts(victim.userId);
    for (const [table, n] of Object.entries(counts)) {
      expect(n, `${table} must be untouched after a refused delete`).toBeGreaterThan(0);
    }
  });

  it("leaves no row behind in any owner-scoped table", async () => {
    const sessionId = await authenticate(victim.email, Buffer.from(PASSWORD, "utf8"));
    expect(sessionId).not.toBeNull();
    createdSessionIds.push(sessionId!);

    const result = await deleteAccount(victim.userId, Buffer.from(PASSWORD, "utf8"));
    expect(result).toBe("deleted");

    const counts = await rowCounts(victim.userId);
    for (const [table, n] of Object.entries(counts)) {
      expect(n, `${table} still holds rows for the deleted user`).toBe(0);
    }
  });

  it("leaves the other user's rows exactly as they were", async () => {
    expect(await rowCounts(bystander.userId)).toEqual(bystanderCountsBefore);
  });

  it("wipes the deleted user's live session from RAM", () => {
    for (const id of createdSessionIds) {
      expect(getSession(id)).toBeNull();
    }
  });

  it("leaves the deleted user unable to log in again", async () => {
    expect(await authenticate(victim.email, Buffer.from(PASSWORD, "utf8"))).toBeNull();
  });

  it("is a no-op the second time — there is no password left to verify", async () => {
    expect(await deleteAccount(victim.userId, Buffer.from(PASSWORD, "utf8"))).toBe(
      "invalid-password",
    );
  });
});
