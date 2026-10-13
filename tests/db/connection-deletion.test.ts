// deleteImportConnection() (src/domain/connections.ts) — removing a file-import
// connection together with everything it imported, so one import source can
// replace another without the old accounts double-counting.
//
// One user gets two fully-populated import connections; only one is deleted.
// Every table that points at an account or a connection must lose exactly the
// doomed connection's rows and keep the sibling's — and the coverage test reads
// that table list out of `information_schema`, so a new account- or
// connection-scoped table nobody teaches the delete about fails this suite.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@/db/schema";
import { NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/domain/auth";
import { createConnection, deleteImportConnection } from "@/domain/connections";
import { createUser } from "@/domain/registration";
import { createSession, destroySession } from "@/lib/auth/session-store";
import { DELETE as deleteRoute } from "@/app/api/connections/[id]/route";
import { cleanupOwners, elevatedDb, elevatedPool } from "./helpers";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN;
if (!SIGNUP_TOKEN) throw new Error("MONI_SIGNUP_TOKEN must be set in the test environment");

const owners: string[] = [];
afterAll(() => cleanupOwners(owners));

// Placeholder ciphertext — these tests assert row existence, not decryption.
const ct = (s: string) => Buffer.from(s, "utf8");

/** Tables the delete clears, by the account or connection they point at. */
const HANDLED = [
  "account_balance_snapshots",
  "accounts",
  "investment_activity_coverage",
  "investment_activity_evidence",
  "investment_corporate_action_evidence",
  "investment_disposal_resolution_queue",
  "investment_opening_cash_evidence",
  "investment_opening_lot_evidence",
  "investment_reconciliation_quality",
  "investment_snapshot_details",
  "investment_source_evidence",
  "investment_tax_lots",
  "long_term_savings_details",
  "long_term_savings_snapshots",
  "sync_runs",
];
/** Written only by bank syncs; on an import account their FK fails the delete closed. */
const BANK_ONLY = ["credit_card_details", "entries", "sync_staging"];
/** Children with no account column, removed through their parent. */
const CHILDREN = [
  "investment_lot_closures",
  "investment_snapshot_cash_balances",
  "investment_snapshot_positions",
  "long_term_savings_snapshot_deposits",
  "long_term_savings_snapshot_tracks",
];

const PASSWORD = "test password";
/** A fresh Buffer per call — the domain function may wipe what it is given. */
const pw = () => Buffer.from(PASSWORD);

async function newUser(): Promise<string> {
  const { userId, dataKey } = await createUser(
    `conn-delete-${randomUUID()}@test.moni`,
    Buffer.from(PASSWORD),
    SIGNUP_TOKEN!,
  );
  dataKey.fill(0);
  owners.push(userId);
  return userId;
}

async function callDelete(
  connectionId: string,
  sessionId?: string,
  body: unknown = { password: PASSWORD },
): Promise<number> {
  const headers = new Headers({ "content-type": "application/json" });
  if (sessionId) headers.set("cookie", `${SESSION_COOKIE}=${sessionId}`);
  const req = new NextRequest(`http://localhost/api/connections/${connectionId}`, {
    method: "DELETE",
    headers,
    body: JSON.stringify(body),
  });
  const res = await deleteRoute(req, { params: Promise.resolve({ id: connectionId }) });
  return res.status;
}

/**
 * One import connection with a long-term-savings account (balance, details,
 * report with a deposit and a track) and an investment account carrying a row
 * in every investment table. Returns the connection id.
 */
async function seedImportConnection(userId: string, label: string): Promise<string> {
  const { id: connectionId } = await createConnection(
    userId,
    "schwab_positions_csv",
    null,
    null,
    label,
  );
  const [run] = await elevatedDb
    .insert(schema.syncRuns)
    .values({ ownerId: userId, connectionId, status: "succeeded" })
    .returning({ id: schema.syncRuns.id });
  const syncRunId = run.id;

  // Long-term savings.
  const [savings] = await elevatedDb
    .insert(schema.accounts)
    .values({
      ownerId: userId,
      connectionId,
      accountType: "long_term_savings",
      classification: "asset",
      nameCt: ct(`${label}-pension`),
      currency: "ILS",
    })
    .returning({ id: schema.accounts.id });
  await elevatedDb.insert(schema.longTermSavingsDetails).values({
    ownerId: userId,
    accountId: savings.id,
    product: "pension",
    liquidity: "locked_retirement",
  });
  const [balance] = await elevatedDb
    .insert(schema.accountBalanceSnapshots)
    .values({
      ownerId: userId,
      accountId: savings.id,
      date: "2026-03-31",
      nativeBalanceCt: ct("76243"),
      currency: "ILS",
      source: "long_term_savings",
    })
    .returning({ id: schema.accountBalanceSnapshots.id });
  const [report] = await elevatedDb
    .insert(schema.longTermSavingsSnapshots)
    .values({
      ownerId: userId,
      accountBalanceSnapshotId: balance.id,
      accountId: savings.id,
      connectionId,
      syncRunId,
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
  await elevatedDb.insert(schema.longTermSavingsSnapshotDeposits).values({
    ownerId: userId,
    snapshotId: report.id,
    rowIndex: 0,
    depositDate: "2026-01-01",
    forMonth: "2025-12",
    employeeCt: ct("729"),
    employerContributionCt: ct("781"),
    severanceCt: ct("625"),
    totalCt: ct("2135"),
  });
  await elevatedDb.insert(schema.longTermSavingsSnapshotTracks).values({
    ownerId: userId,
    snapshotId: report.id,
    rowIndex: 0,
    nameCt: ct(`${label}-track`),
    returnPct: "-3.81",
    annualCostPct: "0.10",
  });

  // Investments.
  const [investment] = await elevatedDb
    .insert(schema.accounts)
    .values({
      ownerId: userId,
      connectionId,
      accountType: "investment",
      classification: "asset",
      nameCt: ct(`${label}-brokerage`),
      currency: "USD",
    })
    .returning({ id: schema.accounts.id });
  const [instrument] = await elevatedDb
    .insert(schema.instruments)
    .values({
      ownerId: userId,
      kind: "etf",
      canonicalNameCt: ct(`${label}-name`),
      canonicalSymbolCt: ct(`${label}-symbol`),
    })
    .returning({ id: schema.instruments.id });
  const activity = (type: "buy" | "sell", key: string) => ({
    ownerId: userId,
    connectionId,
    syncRunId,
    accountId: investment.id,
    instrumentId: instrument.id,
    source: "ibkr_flex" as const,
    activityType: type,
    idempotencyKey: ct(`${label}-${key}`),
    tradeDate: "2026-01-15",
    quantityCt: ct(type === "buy" ? "1" : "-1"),
    quantityUnit: "shares" as const,
    priceCt: ct("100"),
    currency: "USD",
    rawTypeCt: ct("Trade"),
    provenance: "broker_reported" as const,
  });
  const [buy] = await elevatedDb
    .insert(schema.investmentActivityEvidence)
    .values(activity("buy", "buy"))
    .returning({ id: schema.investmentActivityEvidence.id });
  const [sell] = await elevatedDb
    .insert(schema.investmentActivityEvidence)
    .values(activity("sell", "sell"))
    .returning({ id: schema.investmentActivityEvidence.id });
  await elevatedDb.insert(schema.investmentOpeningLotEvidence).values({
    ownerId: userId,
    accountId: investment.id,
    instrumentId: instrument.id,
    idempotencyKey: ct(`${label}-opening`),
    tradeDate: "2020-01-02",
    originalQuantityCt: ct("1"),
    remainingQuantityCt: ct("1"),
    quantityUnit: "shares",
    totalCostCt: ct("80"),
    currency: "USD",
    lockedFxProvenance: "unresolved",
    provenance: "imported",
  });
  await elevatedDb.insert(schema.investmentOpeningCashEvidence).values({
    ownerId: userId,
    accountId: investment.id,
    currency: "USD",
    amountCt: ct("250"),
    provenance: "user_entered",
  });
  await elevatedDb.insert(schema.investmentCorporateActionEvidence).values({
    ownerId: userId,
    connectionId,
    syncRunId,
    accountId: investment.id,
    instrumentId: instrument.id,
    source: "ibkr_flex",
    idempotencyKey: ct(`${label}-corporate-action`),
    actionDate: "2026-01-20",
    rawTypeCt: ct("FS"),
    provenance: "broker_reported",
  });
  await elevatedDb.insert(schema.investmentActivityCoverage).values({
    ownerId: userId,
    accountId: investment.id,
    source: "ibkr_flex",
    metric: "dividends",
    coverageStart: "2026-01-01",
    coverageBasis: "provider_declared",
    completeness: "complete",
  });
  const [taxLot] = await elevatedDb
    .insert(schema.investmentTaxLots)
    .values({
      ownerId: userId,
      accountId: investment.id,
      instrumentId: instrument.id,
      acquisitionActivityId: buy.id,
      derivationKey: ct(`${label}-derivation`),
      policyVersion: "broker-reported-else-user-selected/v1",
      tradeDate: "2026-01-15",
      originalQuantityCt: ct("1"),
      remainingQuantityCt: ct("1"),
      quantityUnit: "shares",
      costBasisCt: ct("100"),
      costBasisCurrency: "USD",
      lockedFxProvenance: "unresolved",
      completeness: "partial",
    })
    .returning({ id: schema.investmentTaxLots.id });
  await elevatedDb.insert(schema.investmentLotClosures).values({
    ownerId: userId,
    sellActivityEvidenceId: sell.id,
    closedTaxLotId: taxLot.id,
    closedQuantityCt: ct("1"),
    proceedsCt: ct("110"),
    realizedCostBasisCt: ct("100"),
    lockedFxConvention: "ILS_PER_USD",
    lockedFxProvenance: "unresolved",
    allocationProvenance: "broker_reported",
  });
  const [quality] = await elevatedDb
    .insert(schema.investmentReconciliationQuality)
    .values({
      ownerId: userId,
      accountId: investment.id,
      instrumentId: instrument.id,
      dimension: "unexplained_opening_quantity",
      expectedValueCt: ct("1"),
      observedValueCt: ct("0"),
      completeness: "partial",
    })
    .returning({ id: schema.investmentReconciliationQuality.id });
  await elevatedDb.insert(schema.investmentDisposalResolutionQueue).values({
    ownerId: userId,
    accountId: investment.id,
    reconciliationQualityId: quality.id,
    kind: "reconciliation_gap",
    policyVersion: "broker-reported-else-user-selected/v1",
  });
  // A snapshot and its detail row must land together — a deferred trigger
  // checks the pair at commit.
  await elevatedDb.transaction(async (tx) => {
    const [snapshot] = await tx
      .insert(schema.accountBalanceSnapshots)
      .values({
        ownerId: userId,
        accountId: investment.id,
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
        accountId: investment.id,
        connectionId,
        syncRunId,
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
  });
  await elevatedDb.insert(schema.investmentSourceEvidence).values({
    ownerId: userId,
    connectionId,
    syncRunId,
    accountId: investment.id,
    source: "ibkr_flex",
    sourceAsOf: new Date("2026-01-31T12:00:00Z"),
    sourceAsOfPrecision: "timestamp",
    validationVersion: 1,
    positionRowCount: 1,
    cashRowCount: 1,
    qualityCodes: [],
    normalizedFingerprint: ct(`${label}-fingerprint`),
  });
  return connectionId;
}

async function count(table: string, userId: string): Promise<number> {
  const { rows } = await elevatedPool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM "${table}" WHERE owner_id = $1::uuid`,
    [userId],
  );
  return Number(rows[0].n);
}

/** Rows in `table` that belong to `connectionId`, directly or via its accounts. */
async function countForConnection(table: string, connectionId: string): Promise<number> {
  const { rows: cols } = await elevatedPool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
        AND column_name IN ('account_id', 'connection_id')`,
    [table],
  );
  const names = cols.map((c) => c.column_name);
  const where = names.includes("connection_id")
    ? "connection_id = $1::uuid"
    : "account_id IN (SELECT id FROM accounts WHERE connection_id = $1::uuid)";
  const { rows } = await elevatedPool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM "${table}" WHERE ${where}`,
    [connectionId],
  );
  return Number(rows[0].n);
}

describe("deleteImportConnection", () => {
  it("knows every table that points at an account or a connection", async () => {
    const { rows } = await elevatedPool.query<{ table_name: string }>(
      `SELECT DISTINCT c.table_name
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public'
          AND c.column_name IN ('account_id', 'connection_id')
          AND t.table_type = 'BASE TABLE'
        ORDER BY c.table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([...HANDLED, ...BANK_ONLY].sort());
  });

  it("removes the connection and everything it imported, and nothing else", async () => {
    const userId = await newUser();
    const doomed = await seedImportConnection(userId, "doomed");
    const kept = await seedImportConnection(userId, "kept");

    const keptBefore: Record<string, number> = {};
    for (const table of HANDLED) {
      expect(await countForConnection(table, doomed), table).toBeGreaterThan(0);
      keptBefore[table] = await countForConnection(table, kept);
    }
    const childrenBefore: Record<string, number> = {};
    for (const table of CHILDREN) childrenBefore[table] = await count(table, userId);
    const instrumentsBefore = await count("instruments", userId);

    expect(await deleteImportConnection(userId, doomed, pw())).toBe("deleted");

    for (const table of HANDLED) {
      expect(await countForConnection(table, doomed), table).toBe(0);
      expect(await countForConnection(table, kept), table).toBe(keptBefore[table]);
    }
    // Each connection seeded one row per child table; only the doomed one's go.
    for (const table of CHILDREN)
      expect(await count(table, userId), table).toBe(childrenBefore[table] - 1);
    // Instruments are user-level reference rows shared across accounts.
    expect(await count("instruments", userId)).toBe(instrumentsBefore);
    const { rows } = await elevatedPool.query(`SELECT 1 FROM connections WHERE id = $1::uuid`, [
      doomed,
    ]);
    expect(rows).toHaveLength(0);
  });

  it("refuses a wrong password before touching anything", async () => {
    const userId = await newUser();
    const connectionId = await seedImportConnection(userId, "wrong-password");
    expect(await deleteImportConnection(userId, connectionId, Buffer.from("not it"))).toBe(
      "invalid_password",
    );
    expect(await countForConnection("accounts", connectionId)).toBe(2);
  });

  it("refuses a bank connection, a running import, and another user's connection", async () => {
    const userId = await newUser();
    const [bank] = await elevatedDb
      .insert(schema.connections)
      .values({
        ownerId: userId,
        connectorId: "leumi",
        credentialsCt: ct("creds"),
        status: "active",
      })
      .returning({ id: schema.connections.id });
    expect(await deleteImportConnection(userId, bank.id, pw())).toBe("not_import");

    const running = await seedImportConnection(userId, "running");
    await elevatedDb
      .insert(schema.syncRuns)
      .values({ ownerId: userId, connectionId: running, status: "running" });
    expect(await deleteImportConnection(userId, running, pw())).toBe("sync_running");
    expect(await countForConnection("accounts", running)).toBe(2);

    const other = await newUser();
    expect(await deleteImportConnection(other, running, pw())).toBe("not_found");
    expect(await countForConnection("accounts", running)).toBe(2);
  });

  it("DELETE route: needs a session and the password; 400 for a bank, 200 then 404 for an import", async () => {
    const { userId, dataKey } = await createUser(
      `conn-delete-route-${randomUUID()}@test.moni`,
      Buffer.from(PASSWORD),
      SIGNUP_TOKEN!,
    );
    owners.push(userId);
    const sessionId = createSession(userId, dataKey, "ILS");
    try {
      const imported = await seedImportConnection(userId, "route");
      const [bank] = await elevatedDb
        .insert(schema.connections)
        .values({
          ownerId: userId,
          connectorId: "leumi",
          credentialsCt: ct("creds"),
          status: "active",
        })
        .returning({ id: schema.connections.id });

      expect(await callDelete(imported)).toBe(401);
      expect(await callDelete(imported, sessionId, {})).toBe(400);
      expect(await callDelete(imported, sessionId, { password: "not it" })).toBe(401);
      expect(await countForConnection("accounts", imported)).toBe(2);
      expect(await callDelete(bank.id, sessionId)).toBe(400);
      expect(await callDelete(imported, sessionId)).toBe(200);
      expect(await countForConnection("accounts", imported)).toBe(0);
      expect(await callDelete(imported, sessionId)).toBe(404);
    } finally {
      destroySession(sessionId);
    }
  });
});
