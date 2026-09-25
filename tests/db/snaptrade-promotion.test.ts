import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { withUser } from "@/db/client";
import * as schema from "@/db/schema";
import { promoteInvestmentSnapshot } from "@/domain/investment-promotion";
import { deriveAndReconcileInvestmentActivity } from "@/domain/investment-activity-sync";
import { readInvestmentResolutionItem } from "@/domain/investment-activity-resolution";
import { recordOpeningCashForGap } from "@/domain/investment-opening-cash";
import { readInvestmentReturns } from "@/domain/investment-returns";
import { listTiingoQuoteTargetsForUser } from "@/domain/investment-valuation";
import { createUser } from "@/domain/registration";
import {
  normalizeSnaptradeActivity,
  normalizeSnaptradeHoldings,
  parseJsonPreservingNumbers,
  type InvestmentSyncEnvelope,
  type SnaptradeAccountPayload,
} from "@/lib/investments";
import { cleanupOwners, elevatedDb } from "./helpers";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN;
if (!SIGNUP_TOKEN) throw new Error("MONI_SIGNUP_TOKEN must be set in the test environment");

const users: string[] = [];

async function fixture() {
  const { userId, dataKey } = await createUser(
    `${randomUUID()}@test.moni`,
    Buffer.from("test password"),
    SIGNUP_TOKEN!,
  );
  users.push(userId);
  const connectionId = randomUUID();
  await withUser(userId, (tx) =>
    tx.insert(schema.connections).values({
      id: connectionId,
      ownerId: userId,
      connectorId: "snaptrade",
      mode: "credentialed_fetch",
      credentialsCt: Buffer.from([1]),
      status: "active",
    }),
  );
  await elevatedDb
    .insert(schema.fxRates)
    .values({
      id: randomUUID(),
      fromCurrency: "USD",
      toCurrency: "ILS",
      date: "2026-08-01",
      rate: "3.5",
      source: "boi",
    })
    .onConflictDoNothing();
  const syncRunId = randomUUID();
  await withUser(userId, (tx) =>
    tx
      .insert(schema.syncRuns)
      .values({ id: syncRunId, ownerId: userId, connectionId, status: "running" }),
  );
  return { userId, dataKey, connectionId, syncRunId };
}

/** The exact payload a live Schwab-via-SnapTrade account returned. */
function snaptradeEnvelope(): InvestmentSyncEnvelope {
  const positions = parseJsonPreservingNumbers(
    readFileSync(
      join(process.cwd(), "tests/fixtures/investments/snaptrade-positions.json"),
      "utf8",
    ),
  ) as SnaptradeAccountPayload["positions"];
  return normalizeSnaptradeHoldings([
    {
      account: {
        id: "c925331b-52b8-47ff-95f0-aefacc4236a8",
        institution_account_id: "EB5AE622BC903C53DD86B729D2C920AB0089806D7849F5414B170F6FB372EE23",
        institution_name: "Schwab",
        sync_status: {
          holdings: {
            last_successful_sync: "2026-08-01T18:30:01.430350+00:00",
            initial_sync_completed: true,
          },
        },
        balance: { total: { amount: "191142.33", currency: "USD" } },
      },
      balances: [{ currency: { code: "USD" }, cash: "252.18" }],
      positions,
      activities: [],
    },
  ]);
}

// Guards the whole SnapTrade write path against the schema, not just the
// normalizer. sync_runs.investment_source is a `text` column with its own
// CHECK constraint (drizzle/0019) rather than the investment_source enum, so a
// new source that passes every unit test can still fail at the final status
// update — which is exactly what happened, reported only as a generic failure.
describe("snaptrade promotion", () => {
  afterAll(async () => cleanupOwners(users));

  it("promotes a real snaptrade envelope and records the source on the run", async () => {
    const f = await fixture();
    const result = await promoteInvestmentSnapshot({ ...f, envelope: snaptradeEnvelope() });
    expect(result).toEqual({ outcome: "promoted", accounts: 1, positions: 1, cashBalances: 1 });
    await withUser(f.userId, async (tx) => {
      const [run] = await tx
        .select()
        .from(schema.syncRuns)
        .where(eq(schema.syncRuns.id, f.syncRunId));
      expect(run.status).toBe("succeeded");
      expect(run.investmentSource).toBe("snaptrade");
      const [position] = await tx.select().from(schema.investmentSnapshotPositions);
      // SnapTrade carries no market value, so promotion derives quantity x price.
      expect(position.brokerValuationBasis).toBe("quantity_times_price");
      // 518.4274 x 368.21 + 252.18 lands 0.002954 USD above the broker's own
      // 191142.33 total. That is the price's rounding, not a missing holding,
      // so it must not read as a mismatch.
      const [detail] = await tx.select().from(schema.investmentSnapshotDetails);
      expect(detail.reconciliationState).toBe("matched");
    });
  });

  it("still reports a mismatch when a holding is genuinely missing", async () => {
    // The slack only covers what the reported price's rounding can hide
    // (quantity x half a cent, about 9 ILS here). A whole absent position is
    // orders of magnitude outside it.
    const f = await fixture();
    const envelope = snaptradeEnvelope();
    envelope.accounts[0].brokerTotal.amount = "241142.33";
    await promoteInvestmentSnapshot({ ...f, envelope });
    await withUser(f.userId, async (tx) => {
      const [detail] = await tx.select().from(schema.investmentSnapshotDetails);
      expect(detail.reconciliationState).toBe("mismatch");
    });
  });
});

// An account whose broker total is stated in a different currency from the
// holdings inside it — the IBKR shape: USD positions, an ILS-denominated NAV.
// Live data put these 6.2 bps apart, and the rounding slack was 0, so this
// account reported "reconciliation mismatch" on every single sync.
function crossCurrencyEnvelope(brokerTotalIls: string): InvestmentSyncEnvelope {
  const envelope = snaptradeEnvelope();
  envelope.accounts[0].baseCurrency = "ILS";
  envelope.accounts[0].brokerTotal = {
    amount: brokerTotalIls,
    currency: "ILS",
    asOf: envelope.accounts[0].brokerTotal.asOf,
  };
  return envelope;
}

describe("cross-currency reconciliation", () => {
  afterAll(async () => cleanupOwners(users));

  // 518.4274 x 368.21 + 252.18 USD at the fixture's 3.5 rate is 668,998.17 ILS.
  it("tolerates the broker and BOI disagreeing on the rate", async () => {
    const f = await fixture();
    // 20 bps above what BOI's rate produces: an ordinary gap between two FX
    // authorities pricing the same day, not a missing holding.
    await promoteInvestmentSnapshot({ ...f, envelope: crossCurrencyEnvelope("670336.16") });
    await withUser(f.userId, async (tx) => {
      const [detail] = await tx.select().from(schema.investmentSnapshotDetails);
      expect(detail.reconciliationState).toBe("matched");
    });
  });

  it("still catches a real gap across currencies", async () => {
    // 200 bps out — four times the FX allowance, so the tolerance must not
    // swallow it.
    const f = await fixture();
    await promoteInvestmentSnapshot({ ...f, envelope: crossCurrencyEnvelope("682378.13") });
    await withUser(f.userId, async (tx) => {
      const [detail] = await tx.select().from(schema.investmentSnapshotDetails);
      expect(detail.reconciliationState).toBe("mismatch");
    });
  });

  it("does not widen the allowance when everything is in the broker's currency", async () => {
    // Same 20 bps, but with a USD total against USD holdings there is no FX
    // conversion to be generous about.
    const f = await fixture();
    const envelope = snaptradeEnvelope();
    envelope.accounts[0].brokerTotal.amount = "191524.61";
    await promoteInvestmentSnapshot({ ...f, envelope });
    await withUser(f.userId, async (tx) => {
      const [detail] = await tx.select().from(schema.investmentSnapshotDetails);
      expect(detail.reconciliationState).toBe("mismatch");
    });
  });
});

describe("snaptrade instrument metadata", () => {
  afterAll(async () => cleanupOwners(users));

  it("refreshes a mapping's exchange when the provider reports a new one", async () => {
    // The first sync stored the raw MIC. Once the normalizer translates it,
    // valuation must see the translated venue — the mapping is the only place
    // listTiingoQuoteTargets reads it from, so a stale one silently keeps the
    // position ineligible for a quote forever.
    const f = await fixture();
    const stale = snaptradeEnvelope();
    stale.accounts[0].positions[0].exchange = "ARCX";
    await promoteInvestmentSnapshot({ ...f, envelope: stale });
    expect(await listTiingoQuoteTargetsForUser(f.userId, f.dataKey)).toEqual([]);

    const fresh = snaptradeEnvelope();
    fresh.sourceAsOf = { value: "2026-08-02T18:30:01.430350+00:00", precision: "timestamp" };
    fresh.accounts[0].brokerTotal.asOf = "2026-08-02T18:30:01.430350+00:00";
    const syncRunId = randomUUID();
    await withUser(f.userId, (tx) =>
      tx.insert(schema.syncRuns).values({
        id: syncRunId,
        ownerId: f.userId,
        connectionId: f.connectionId,
        status: "running",
      }),
    );
    await promoteInvestmentSnapshot({ ...f, syncRunId, envelope: fresh });
    const targets = await listTiingoQuoteTargetsForUser(f.userId, f.dataKey);
    expect(targets.map((target) => target.symbol)).toEqual(["VTI"]);
  });
});

function fixtureActivities(): SnaptradeAccountPayload["activities"] {
  return (
    parseJsonPreservingNumbers(
      readFileSync(
        join(process.cwd(), "tests/fixtures/investments/snaptrade-activities.json"),
        "utf8",
      ),
    ) as { data: SnaptradeAccountPayload["activities"] }
  ).data;
}

function activityEvidence(activities: SnaptradeAccountPayload["activities"]) {
  return normalizeSnaptradeActivity([
    {
      account: {
        id: "c925331b-52b8-47ff-95f0-aefacc4236a8",
        institution_account_id: "EB5AE622BC903C53DD86B729D2C920AB0089806D7849F5414B170F6FB372EE23",
        sync_status: {
          holdings: { last_successful_sync: "2026-08-01T00:00:00Z", initial_sync_completed: true },
        },
        balance: { total: { amount: "0", currency: "USD" } },
      },
      balances: [],
      positions: { results: [], data_freshness: { as_of: "2026-08-01T00:00:00Z" } },
      activities,
    },
  ]);
}

async function nextRun(f: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  const syncRunId = randomUUID();
  await withUser(f.userId, (tx) =>
    tx.insert(schema.syncRuns).values({
      id: syncRunId,
      ownerId: f.userId,
      connectionId: f.connectionId,
      status: "running",
    }),
  );
  return syncRunId;
}

// The worker's order: promote the snapshot together with its activity, then
// derive lots and reconcile against it.
describe("snaptrade activity sync", () => {
  afterAll(async () => cleanupOwners(users));

  it("brings in lots and dividends on the first sync, on the snapshot's own instrument", async () => {
    const f = await fixture();
    await promoteInvestmentSnapshot({
      ...f,
      envelope: snaptradeEnvelope(),
      activityEvidence: activityEvidence(fixtureActivities()),
    });
    await deriveAndReconcileInvestmentActivity(f);

    await withUser(f.userId, async (tx) => {
      const [position] = await tx.select().from(schema.investmentSnapshotPositions);
      const activities = await tx.select().from(schema.investmentActivityEvidence);
      expect(activities).toHaveLength(5);
      const lots = await tx.select().from(schema.investmentTaxLots);
      expect(lots).toHaveLength(2);
      expect(new Set(lots.map((lot) => lot.instrumentId))).toEqual(
        new Set([position.instrumentId]),
      );
      const dividends = activities.filter((row) => row.activityType === "dividend");
      expect(dividends.map((row) => row.instrumentId)).toEqual([position.instrumentId]);
      // 10.358 derived shares against 518.4274 held: the pre-history shares
      // surface as a gap rather than being invented.
      const gaps = await tx.select().from(schema.investmentReconciliationQuality);
      expect(gaps.map((gap) => gap.dimension)).toContain("unexplained_opening_quantity");
    });

    // SnapTrade re-serves the whole history every sync; it must not double.
    const replayRun = await nextRun(f);
    await promoteInvestmentSnapshot({
      ...f,
      syncRunId: replayRun,
      envelope: snaptradeEnvelope(),
      activityEvidence: activityEvidence(fixtureActivities()),
    });
    await deriveAndReconcileInvestmentActivity(f);
    await withUser(f.userId, async (tx) => {
      expect(await tx.select().from(schema.investmentActivityEvidence)).toHaveLength(5);
      expect(await tx.select().from(schema.investmentTaxLots)).toHaveLength(2);
    });
  });

  it("completes an instrument that activity created before the snapshot held it", async () => {
    // Bought and sold out between two syncs: only activity knows the security,
    // so ingestion creates a bare generic instrument. When it is bought again
    // and held, the snapshot reports it as an ETF.
    const f = await fixture();
    const [, , buy] = fixtureActivities();
    const newBuy = {
      ...buy,
      id: "00000000-0000-4000-8000-0000000000aa",
      symbol: { symbol: "VXUS", figi_code: "BBG002N7Q4X4" },
    };
    await promoteInvestmentSnapshot({
      ...f,
      envelope: snaptradeEnvelope(),
      activityEvidence: activityEvidence([newBuy]),
    });
    const envelope = snaptradeEnvelope();
    envelope.accounts[0].positions.push({
      ...envelope.accounts[0].positions[0],
      sourceSecurityId: "BBG002N7Q4X4",
      symbol: "VXUS",
      name: "Vanguard Total International Stock ETF",
      quantity: "0.358",
    });
    const result = await promoteInvestmentSnapshot({ ...f, syncRunId: await nextRun(f), envelope });
    expect(result).toMatchObject({ outcome: "promoted", positions: 2 });
    await withUser(f.userId, async (tx) => {
      const [activity] = await tx.select().from(schema.investmentActivityEvidence);
      const [instrument] = await tx
        .select()
        .from(schema.instruments)
        .where(eq(schema.instruments.id, activity.instrumentId!));
      expect(instrument.kind).toBe("etf");
      const positions = await tx.select().from(schema.investmentSnapshotPositions);
      expect(positions.map((position) => position.instrumentId)).toContain(instrument.id);
    });
  });
});

// SnapTrade's Schwab history starts after the account was funded, so activity
// can never explain all of the snapshot's cash.
describe("opening cash", () => {
  afterAll(async () => cleanupOwners(users));

  it("limits a cash gap to returns, and closes it once opening cash is recorded", async () => {
    const f = await fixture();
    // Every share is explained by activity; only cash is not: 252.18 held
    // against 201.65 the history accounts for.
    // Rates for the fixture's buy dates, so the lots' acquisition FX locks
    // and the only thing left unexplained is cash.
    await elevatedDb
      .insert(schema.fxRates)
      .values(
        ["2024-10-01", "2025-03-18"].map((date) => ({
          id: randomUUID(),
          fromCurrency: "USD",
          toCurrency: "ILS",
          date,
          rate: "3.7",
          source: "boi",
        })),
      )
      .onConflictDoNothing();
    const envelope = snaptradeEnvelope();
    envelope.accounts[0].positions[0].quantity = "10.358";
    await promoteInvestmentSnapshot({
      ...f,
      envelope,
      activityEvidence: activityEvidence(fixtureActivities()),
    });
    await deriveAndReconcileInvestmentActivity(f);
    const [account] = await withUser(f.userId, (tx) => tx.select().from(schema.accounts));
    const returns = () =>
      readInvestmentReturns({ userId: f.userId, accountId: account.id, dataKey: f.dataKey });

    const before = await returns();
    expect(before.unrealizedGain.quality.completeness).not.toBe("partial");
    expect(before.dividendIncome.quality.completeness).not.toBe("partial");

    const [item] = await withUser(f.userId, (tx) =>
      tx
        .select()
        .from(schema.investmentDisposalResolutionQueue)
        .where(eq(schema.investmentDisposalResolutionQueue.status, "pending")),
    );
    const session = {
      id: "opening-cash-test",
      userId: f.userId,
      dataKey: Buffer.from(f.dataKey),
      baseCurrency: "ILS",
      syncPromptDismissed: false,
      expiresAt: Date.now() + 60_000,
    };
    const view = await readInvestmentResolutionItem(session, item.id);
    expect(view?.gap).toMatchObject({ currency: "USD", suggestedOpeningCash: "50.53" });
    expect(view?.affectedMetrics).toEqual(["Returns"]);

    expect(
      await recordOpeningCashForGap({ ...f, queueId: item.id, amount: "50.53" }),
    ).toMatchObject({ accountId: account.id, gaps: 0 });
    await withUser(f.userId, async (tx) => {
      const [resolved] = await tx
        .select()
        .from(schema.investmentDisposalResolutionQueue)
        .where(eq(schema.investmentDisposalResolutionQueue.id, item.id));
      expect(resolved.status).toBe("resolved");
      // Opening cash seeds reconciliation only; it is never a deposit.
      expect(
        (await tx.select().from(schema.investmentActivityEvidence)).filter(
          (row) => row.activityType === "deposit",
        ),
      ).toHaveLength(1);
    });
  });

  it("refuses to record opening cash against a gap that is not about cash", async () => {
    const f = await fixture();
    await promoteInvestmentSnapshot({
      ...f,
      envelope: snaptradeEnvelope(),
      activityEvidence: activityEvidence(fixtureActivities()),
    });
    await deriveAndReconcileInvestmentActivity(f);
    const items = await withUser(f.userId, (tx) =>
      tx
        .select({
          id: schema.investmentDisposalResolutionQueue.id,
          dimension: schema.investmentReconciliationQuality.dimension,
        })
        .from(schema.investmentDisposalResolutionQueue)
        .innerJoin(
          schema.investmentReconciliationQuality,
          eq(
            schema.investmentReconciliationQuality.id,
            schema.investmentDisposalResolutionQueue.reconciliationQualityId,
          ),
        ),
    );
    const quantityGap = items.find((row) => row.dimension !== "cash_balance")!;
    await expect(
      recordOpeningCashForGap({ ...f, queueId: quantityGap.id, amount: "1" }),
    ).rejects.toMatchObject({ code: "not_a_cash_gap" });
  });
});
