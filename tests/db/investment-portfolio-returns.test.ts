import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { encText } from "@/domain/fields";
import {
  calculateMoneyWeightedReturn,
  readInvestmentReturns,
  readPortfolioInvestmentReturns,
} from "@/domain/investment-returns";
import { getDevUserDataKey } from "@/lib/crypto";
import { cleanupFxRates, cleanupOwners, elevatedDb, elevatedPool } from "./helpers";

// Two ILS-denominated accounts with the SAME two snapshot dates but different
// value trajectories, so the correct portfolio TWR (from the combined series)
// is provably different from the average of the per-account TWRs — the guard
// against any "average the per-account rates" shortcut.
//
//   Account A: 100 -> 200   (per-account TWR = 1.0)
//   Account B: 900 -> 990   (per-account TWR = 0.1)
//   Portfolio: 1000 -> 1190 (combined TWR    = 0.19)
//   Average of per-account TWRs = (1.0 + 0.1) / 2 = 0.55  != 0.19
const D0 = "2025-01-01";
const D1 = "2025-06-01";

function weekStartSunday(date: string): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() - at.getUTCDay());
  return at.toISOString().slice(0, 10);
}

describe("portfolio-aggregate investment returns", () => {
  let userId: string;
  let emptyUserId: string;
  let accountA: string;
  let accountB: string;
  let instrumentId: string;
  const fxRateIds: string[] = [];

  async function seedSnapshot(
    userId: string,
    connectionId: string,
    syncRunId: string,
    accountId: string,
    dataKey: Uint8Array,
    date: string,
    ilsValue: string,
  ) {
    const balanceSnapshotId = randomUUID();
    const snapshotId = randomUUID();
    const asOf = new Date(`${date}T12:00:00Z`);
    await elevatedDb.transaction(async (tx) => {
      await tx.insert(schema.accountBalanceSnapshots).values({
        id: balanceSnapshotId,
        ownerId: userId,
        accountId,
        date,
        source: "investment",
      });
      await tx.insert(schema.investmentSnapshotDetails).values({
        id: snapshotId,
        ownerId: userId,
        accountBalanceSnapshotId: balanceSnapshotId,
        accountId,
        connectionId,
        syncRunId,
        weekStart: weekStartSunday(date),
        source: "ibkr_flex",
        sourceAsOf: asOf,
        sourceAsOfPrecision: "timestamp",
        brokerTotalCt: encText(dataKey, ilsValue, snapshotId, "broker_total_ct", 1),
        brokerTotalCurrency: "ILS",
        reconciliationState: "matched",
        validationVersion: 1,
      });
      const positionId = randomUUID();
      await tx.insert(schema.investmentSnapshotPositions).values({
        id: positionId,
        ownerId: userId,
        snapshotId,
        instrumentId,
        quantityCt: encText(dataKey, "1", positionId, "quantity_ct", 1),
        quantityUnit: "shares",
        currency: "ILS",
        sourceValueCt: encText(dataKey, ilsValue, positionId, "source_value_ct", 1),
        sourceValueCurrency: "ILS",
        sourceAsOf: asOf,
        brokerValuationBasis: "market_value",
      });
    });
  }

  async function seedDividend(
    userId: string,
    connectionId: string,
    syncRunId: string,
    accountId: string,
    dataKey: Uint8Array,
    currency: string,
    amount: string,
  ) {
    const id = randomUUID();
    await elevatedDb.insert(schema.investmentActivityEvidence).values({
      id,
      ownerId: userId,
      connectionId,
      syncRunId,
      accountId,
      source: "ibkr_flex",
      activityType: "dividend",
      idempotencyKey: Buffer.from(`dividend-${id}`),
      tradeDate: D1,
      grossAmountCt: encText(dataKey, amount, id, "gross_amount_ct", 1),
      netCashAmountCt: encText(dataKey, amount, id, "net_cash_amount_ct", 1),
      currency,
      rawTypeCt: encText(dataKey, "Dividends", id, "raw_type_ct", 1),
      provenance: "broker_reported",
    });
  }

  beforeAll(async () => {
    const [user] = await elevatedDb
      .insert(schema.users)
      .values({ email: `portfolio-returns-${randomUUID()}@test.moni` })
      .returning({ id: schema.users.id });
    userId = user.id;
    const [empty] = await elevatedDb
      .insert(schema.users)
      .values({ email: `portfolio-empty-${randomUUID()}@test.moni` })
      .returning({ id: schema.users.id });
    emptyUserId = empty.id;
    const [connection] = await elevatedDb
      .insert(schema.connections)
      .values({
        ownerId: userId,
        connectorId: "ibkr_flex",
        credentialsCt: Buffer.from("test-only"),
        status: "active",
      })
      .returning({ id: schema.connections.id });
    const [run] = await elevatedDb
      .insert(schema.syncRuns)
      .values({ ownerId: userId, connectionId: connection.id, status: "succeeded" })
      .returning({ id: schema.syncRuns.id });
    const dataKey = getDevUserDataKey(userId);
    try {
      const [instrument] = await elevatedDb
        .insert(schema.instruments)
        .values({ ownerId: userId, kind: "etf" })
        .returning({ id: schema.instruments.id });
      instrumentId = instrument.id;
      accountA = randomUUID();
      accountB = randomUUID();
      for (const [id, name] of [
        [accountA, "Account A"],
        [accountB, "Account B"],
      ] as const) {
        await elevatedDb.insert(schema.accounts).values({
          id,
          ownerId: userId,
          connectionId: connection.id,
          accountType: "investment",
          classification: "asset",
          nameCt: encText(dataKey, name, id, "name_ct", 1),
          currency: "ILS",
        });
      }
      await seedSnapshot(userId, connection.id, run.id, accountA, dataKey, D0, "100");
      await seedSnapshot(userId, connection.id, run.id, accountA, dataKey, D1, "200");
      await seedSnapshot(userId, connection.id, run.id, accountB, dataKey, D0, "900");
      await seedSnapshot(userId, connection.id, run.id, accountB, dataKey, D1, "990");
      // Native dividends in two currencies, so the portfolio groups native by
      // currency rather than collapsing them.
      await seedDividend(userId, connection.id, run.id, accountA, dataKey, "USD", "10");
      await seedDividend(userId, connection.id, run.id, accountB, dataKey, "ILS", "25");
      // One account's dividend coverage is partial; the merged portfolio metric
      // must therefore be partial, not complete.
      await elevatedDb.insert(schema.investmentActivityCoverage).values([
        {
          ownerId: userId,
          accountId: accountA,
          source: "ibkr_flex",
          metric: "dividends",
          completeness: "partial",
        },
        {
          ownerId: userId,
          accountId: accountB,
          source: "ibkr_flex",
          metric: "dividends",
          completeness: "complete",
        },
      ]);
    } finally {
      dataKey.fill(0);
    }
    for (const [date, rate] of [[D1, "3"]] as const) {
      const [row] = await elevatedDb
        .insert(schema.fxRates)
        .values({ fromCurrency: "USD", toCurrency: "ILS", date, rate, source: "boi" })
        .returning({ id: schema.fxRates.id });
      fxRateIds.push(row.id);
    }
  });

  afterAll(async () => {
    await cleanupOwners([userId, emptyUserId]);
    await cleanupFxRates(fxRateIds);
    await elevatedPool.end();
  });

  function portfolioInput(userId: string) {
    return { userId, now: new Date(`${D1}T18:00:00Z`), dataKey: getDevUserDataKey(userId) };
  }
  function accountInput(accountId: string) {
    return {
      userId,
      accountId,
      now: new Date(`${D1}T18:00:00Z`),
      dataKey: getDevUserDataKey(userId),
    };
  }

  it("computes portfolio TWR/IRR over the COMBINED series, never by averaging per-account rates", async () => {
    const portfolioHeld = portfolioInput(userId);
    const aHeld = accountInput(accountA);
    const bHeld = accountInput(accountB);
    try {
      const [portfolio, a, b] = await Promise.all([
        readPortfolioInvestmentReturns(portfolioHeld),
        readInvestmentReturns(aHeld),
        readInvestmentReturns(bHeld),
      ]);

      // The per-account trajectories are what we expect (proves the ILS
      // valuations flowed through faithfully).
      expect(a.performance.twr.rate).toBe("1");
      expect(b.performance.twr.rate).toBe("0.1");

      // Combined-series portfolio TWR = 1190/1000 - 1.
      expect(portfolio.performance.twr.rate).toBe("0.19");

      // ...which is NOT the average of the two per-account TWRs.
      const averageTwr = new Decimal(a.performance.twr.rate!)
        .plus(b.performance.twr.rate!)
        .div(2)
        .toFixed();
      expect(portfolio.performance.twr.rate).not.toBe(averageTwr);

      // MWR (IRR) is likewise computed once over the combined dated flows.
      const combinedMwr = calculateMoneyWeightedReturn([
        { date: D0, amount: "-1000" },
        { date: D1, amount: "1190" },
      ]);
      expect(portfolio.performance.mwr.rate).toBe(combinedMwr);
      const averageMwr = new Decimal(a.performance.mwr.rate!)
        .plus(b.performance.mwr.rate!)
        .div(2)
        .toFixed();
      expect(portfolio.performance.mwr.rate).not.toBe(averageMwr);
    } finally {
      portfolioHeld.dataKey.fill(0);
      aHeld.dataKey.fill(0);
      bHeld.dataKey.fill(0);
    }
  });

  it("sums ILS dividends, groups native by currency, and merges completeness", async () => {
    const portfolioHeld = portfolioInput(userId);
    const aHeld = accountInput(accountA);
    const bHeld = accountInput(accountB);
    try {
      const [portfolio, a, b] = await Promise.all([
        readPortfolioInvestmentReturns(portfolioHeld),
        readInvestmentReturns(aHeld),
        readInvestmentReturns(bHeld),
      ]);

      // ILS figure is the exact sum of the per-account ILS figures.
      const expectedIls = new Decimal(a.dividendIncome.ils.amount)
        .plus(b.dividendIncome.ils.amount)
        .toFixed();
      expect(portfolio.dividendIncome.ils.amount).toBe(expectedIls);
      expect(portfolio.dividendIncome.bookedCashCount).toBe(2);

      // Native figures are grouped by currency, not blended.
      expect(portfolio.dividendIncome.native.map((figure) => figure.currency)).toEqual([
        "ILS",
        "USD",
      ]);

      // partial (account A) merged with complete (account B) is partial.
      expect(portfolio.dividendIncome.quality.completeness).toBe("partial");
    } finally {
      portfolioHeld.dataKey.fill(0);
      aHeld.dataKey.fill(0);
      bHeld.dataKey.fill(0);
    }
  });

  it("returns a well-formed empty aggregate for a user with no investment accounts", async () => {
    const held = portfolioInput(emptyUserId);
    try {
      const portfolio = await readPortfolioInvestmentReturns(held);
      expect(portfolio.realizedGain.ils.amount).toBe("0");
      expect(portfolio.realizedGain.native).toEqual([]);
      expect(portfolio.dividendIncome.bookedCashCount).toBe(0);
      expect(portfolio.performance.twr.rate).toBeNull();
      expect(portfolio.performance.mwr.rate).toBeNull();
      expect(portfolio.realizedGain.quality.completeness).toBe("unknown");
    } finally {
      held.dataKey.fill(0);
    }
  });
});
