import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { eq } from "drizzle-orm";
import type { Session } from "@/lib/auth/session-store";
import { withUser } from "@/db/client";
import * as schema from "@/db/schema";
import { getOverview } from "@/domain/dashboard";
import { encText } from "@/domain/fields";
import { promoteInvestmentSnapshot } from "@/domain/investment-promotion";
import { israelDate, replaceTiingoQuote } from "@/domain/investment-valuation";
import { createUser } from "@/domain/registration";
import { cleanupOwners, elevatedDb } from "./helpers";

const owners: string[] = [];
const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN!;
afterAll(() => cleanupOwners(owners));

type Owner = { userId: string; dataKey: Buffer; session: Session };
function today(): string {
  return new Date().toISOString().slice(0, 10);
}
function priorMonthEnd(months: number): string {
  const d = new Date(`${today().slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - months + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}
async function owner(): Promise<Owner> {
  const created = await createUser(
    `${randomUUID()}@dashboard.test`,
    Buffer.from("pw"),
    SIGNUP_TOKEN,
  );
  owners.push(created.userId);
  return {
    ...created,
    session: {
      id: randomUUID(),
      userId: created.userId,
      dataKey: created.dataKey,
      baseCurrency: "ILS",
      syncPromptDismissed: false,
      expiresAt: Date.now() + 60_000,
    },
  };
}
async function fx(day: string, currency = "USD", rate = "3.5"): Promise<void> {
  await elevatedDb
    .insert(schema.fxRates)
    .values({
      id: randomUUID(),
      fromCurrency: currency,
      toCurrency: "ILS",
      date: day,
      rate,
      source: "boi",
    })
    .onConflictDoNothing();
}
async function ordinary(
  o: Owner,
  input: {
    balance: string;
    currency: string;
    snapshot?: { date: string; balance: string };
    archivedAt?: Date;
  },
): Promise<string> {
  const id = randomUUID();
  await withUser(o.userId, async (tx) => {
    await tx.insert(schema.accounts).values({
      id,
      ownerId: o.userId,
      accountType: input.balance.startsWith("-") ? "credit_card" : "checking",
      classification: input.balance.startsWith("-") ? "liability" : "asset",
      nameCt: encText(o.dataKey, "Account", id, "name_ct", 1),
      currency: input.currency,
      currentBalanceCt: encText(o.dataKey, input.balance, id, "current_balance_ct", 1),
      archivedAt: input.archivedAt ?? null,
      status: input.archivedAt ? "archived" : "active",
    });
    if (input.snapshot) {
      const snapshotId = randomUUID();
      await tx.insert(schema.accountBalanceSnapshots).values({
        id: snapshotId,
        ownerId: o.userId,
        accountId: id,
        date: input.snapshot.date,
        nativeBalanceCt: encText(
          o.dataKey,
          input.snapshot.balance,
          snapshotId,
          "native_balance_ct",
          1,
        ),
        currency: input.currency,
        source: "manual",
      });
    }
  });
  return id;
}
async function investment(o: Owner, value = "20", cash = "-5"): Promise<string> {
  const connectionId = randomUUID();
  const syncRunId = randomUUID();
  await withUser(o.userId, async (tx) => {
    await tx.insert(schema.connections).values({
      id: connectionId,
      ownerId: o.userId,
      connectorId: "schwab_positions_csv",
      mode: "user_mediated_import",
      credentialsCt: null,
      status: "active",
    });
    await tx
      .insert(schema.syncRuns)
      .values({ id: syncRunId, ownerId: o.userId, connectionId, status: "running" });
  });
  await fx(today());
  await promoteInvestmentSnapshot({
    userId: o.userId,
    connectionId,
    syncRunId,
    dataKey: o.dataKey,
    envelope: {
      source: "schwab_positions_csv",
      coverage: { kind: "bound_single_account", accountRefs: ["****1234"] },
      sourceAsOf: { value: `${today()}T12:00:00Z`, precision: "timestamp" },
      accounts: [
        {
          sourceAccountRef: "****1234",
          baseCurrency: "USD",
          positions: [
            {
              sourceSecurityId: "SPY",
              sourceSecurityIdKind: "schwab_symbol",
              symbol: "SPY",
              exchange: "NYSE",
              assetKind: "etf",
              quantity: "1",
              quantityUnit: "shares",
              currency: "USD",
              sourceValue: value,
              sourceValueCurrency: "USD",
            },
          ],
          cash: [{ currency: "USD", amount: cash }],
          brokerTotal: {
            amount: `${BigInt(value) + BigInt(cash)}`,
            currency: "USD",
            asOf: `${today()}T12:00:00Z`,
          },
        },
      ],
    },
  });
  return connectionId;
}

async function investmentSnapshot(
  o: Owner,
  input: {
    connectionId?: string;
    asOf: string;
    positions: Array<{ symbol: string; value: string }>;
    cash?: string;
  },
): Promise<string> {
  const connectionId = input.connectionId ?? randomUUID();
  if (!input.connectionId)
    await withUser(o.userId, (tx) =>
      tx.insert(schema.connections).values({
        id: connectionId,
        ownerId: o.userId,
        connectorId: "schwab_positions_csv",
        mode: "user_mediated_import",
        credentialsCt: null,
        status: "active",
      }),
    );
  const syncRunId = randomUUID();
  await withUser(o.userId, (tx) =>
    tx.insert(schema.syncRuns).values({
      id: syncRunId,
      ownerId: o.userId,
      connectionId,
      status: "running",
    }),
  );
  await fx(israelDate(new Date(input.asOf)));
  const cash = input.cash ?? "0";
  await promoteInvestmentSnapshot({
    userId: o.userId,
    connectionId,
    syncRunId,
    dataKey: o.dataKey,
    envelope: {
      source: "schwab_positions_csv",
      coverage: { kind: "bound_single_account", accountRefs: ["****5678"] },
      sourceAsOf: { value: input.asOf, precision: "timestamp" },
      accounts: [
        {
          sourceAccountRef: "****5678",
          baseCurrency: "USD",
          positions: input.positions.map((position) => ({
            sourceSecurityId: position.symbol,
            sourceSecurityIdKind: "schwab_symbol",
            symbol: position.symbol,
            exchange: "NYSE",
            assetKind: "etf",
            quantity: "1",
            quantityUnit: "shares",
            currency: "USD",
            sourceValue: position.value,
            sourceValueCurrency: "USD",
          })),
          cash: [{ currency: "USD", amount: cash }],
          brokerTotal: {
            amount: input.positions
              .reduce((total, position) => total.plus(position.value), new Decimal(cash))
              .toFixed(),
            currency: "USD",
            asOf: input.asOf,
          },
        },
      ],
    },
  });
  return connectionId;
}

describe("dashboard net worth", () => {
  it("combines ordinary liabilities and investments exactly, while Tiingo affects only current hero value", async () => {
    const o = await owner();
    await fx(today());
    await ordinary(o, { balance: "100", currency: "ILS" });
    await ordinary(o, { balance: "-10", currency: "USD" });
    const flowsBeforeInvestment = await getOverview(o.session);
    await investment(o);
    const broker = await getOverview(o.session);
    expect(broker.netWorth).toEqual({ amount: "117.5", currency: "ILS" });
    expect({
      months: broker.months,
      income: broker.monthlyIncome,
      expenses: broker.monthlyExpenses,
    }).toEqual({
      months: flowsBeforeInvestment.months,
      income: flowsBeforeInvestment.monthlyIncome,
      expenses: flowsBeforeInvestment.monthlyExpenses,
    });
    const brokerHistory = broker.netWorthHistory.map((point) => point.amount);
    await withUser(o.userId, async (tx) => {
      const [position] = await tx.select().from(schema.investmentSnapshotPositions);
      const [mapping] = await tx
        .select()
        .from(schema.instrumentSourceMappings)
        .where(eq(schema.instrumentSourceMappings.instrumentId, position.instrumentId));
      await replaceTiingoQuote(tx, o.dataKey, {
        instrumentId: position.instrumentId,
        mappingId: mapping.id,
        symbol: "SPY",
        price: "30",
        sourceDate: today(),
        fetchedAt: new Date(),
        splitState: "safe",
        qualityState: "accepted",
      });
    });
    const estimated = await getOverview(o.session);
    expect(estimated.netWorth.amount).toBe("152.5");
    expect(estimated.netWorthHistory.map((point) => point.amount)).toEqual(brokerHistory);
  });

  it("excludes missing and stale FX rather than treating native amounts as ILS", async () => {
    const o = await owner();
    await ordinary(o, { balance: "100", currency: "EUR" });
    await ordinary(o, { balance: "10", currency: "XAA" });
    await fx(priorMonthEnd(2), "XAA");
    await investment(o, "20", "0");
    await withUser(o.userId, (tx) =>
      tx
        .update(schema.investmentSnapshotPositions)
        .set({ currency: "EUR", sourceValueCurrency: "EUR" })
        .where(eq(schema.investmentSnapshotPositions.ownerId, o.userId)),
    );
    const overview = await getOverview(o.session);
    expect(overview.netWorth.amount).toBe("0");
    expect(overview.netWorthMetadata).toMatchObject({
      affectedComponentCount: 4,
      qualityFlags: ["incomplete_fx", "quote_fallback"],
    });
  });

  it("uses latest month-end observation, carries it whole, obeys archive, and is RLS isolated", async () => {
    const o = await owner();
    const other = await owner();
    const first = priorMonthEnd(6);
    const later = priorMonthEnd(5);
    await fx(first, "XZZ", "3");
    await fx(later, "XZZ", "4");
    await ordinary(o, {
      balance: "999",
      currency: "XZZ",
      snapshot: { date: first, balance: "10" },
    });
    await ordinary(o, {
      balance: "999",
      currency: "XZZ",
      snapshot: { date: first, balance: "5" },
      archivedAt: new Date(`${later}T00:00:00Z`),
    });
    await ordinary(other, {
      balance: "500",
      currency: "ILS",
      snapshot: { date: first, balance: "500" },
    });
    const overview = await getOverview(o.session);
    const firstPoint = overview.netWorthHistory.find((point) => point.month === first.slice(0, 7));
    const carriedPoint = overview.netWorthHistory.find(
      (point) => point.month === later.slice(0, 7),
    );
    expect(firstPoint?.amount).toBe("45");
    expect(carriedPoint).toMatchObject({
      amount: "30",
      metadata: { freshness: "stale", qualityFlags: ["carried_forward"] },
    });
    expect(overview.netWorth.amount).toBe("0");
  });

  it("uses Israel-local investment dates and carries complete account snapshots across month ends", async () => {
    const o = await owner();
    const other = await owner();
    const firstCutoff = priorMonthEnd(6);
    const replacementCutoff = priorMonthEnd(3);
    const archiveCutoff = priorMonthEnd(1);
    const firstObservation = `${new Date(
      new Date(`${firstCutoff}T00:00:00Z`).getTime() + 22.5 * 60 * 60 * 1000,
    )
      .toISOString()
      .slice(0, 10)}T22:30:00Z`;

    const ordinaryId = await ordinary(o, {
      balance: "5",
      currency: "ILS",
      snapshot: { date: firstCutoff, balance: "5" },
    });
    await withUser(o.userId, (tx) => {
      const id = randomUUID();
      return tx.insert(schema.accountBalanceSnapshots).values({
        id,
        ownerId: o.userId,
        accountId: ordinaryId,
        date: replacementCutoff,
        nativeBalanceCt: encText(o.dataKey, "5", id, "native_balance_ct", 1),
        currency: "ILS",
        source: "manual",
      });
    });
    const connectionId = await investmentSnapshot(o, {
      asOf: firstObservation,
      positions: [
        { symbol: "SPY", value: "10" },
        { symbol: "QQQ", value: "100" },
      ],
    });
    await investmentSnapshot(o, {
      connectionId,
      asOf: `${replacementCutoff}T12:00:00Z`,
      positions: [{ symbol: "SPY", value: "30" }],
    });
    await investmentSnapshot(other, {
      asOf: `${replacementCutoff}T12:00:00Z`,
      positions: [{ symbol: "SPY", value: "999" }],
    });
    await withUser(other.userId, async (tx) => {
      const [position] = await tx.select().from(schema.investmentSnapshotPositions);
      const [mapping] = await tx
        .select()
        .from(schema.instrumentSourceMappings)
        .where(eq(schema.instrumentSourceMappings.instrumentId, position.instrumentId));
      await replaceTiingoQuote(tx, other.dataKey, {
        instrumentId: position.instrumentId,
        mappingId: mapping.id,
        symbol: "SPY",
        price: "9999",
        sourceDate: today(),
        fetchedAt: new Date(),
        splitState: "safe",
        qualityState: "accepted",
      });
    });
    await withUser(o.userId, async (tx) => {
      const [position] = await tx
        .select()
        .from(schema.investmentSnapshotPositions)
        .where(eq(schema.investmentSnapshotPositions.ownerId, o.userId));
      const [mapping] = await tx
        .select()
        .from(schema.instrumentSourceMappings)
        .where(eq(schema.instrumentSourceMappings.instrumentId, position.instrumentId));
      await replaceTiingoQuote(tx, o.dataKey, {
        instrumentId: position.instrumentId,
        mappingId: mapping.id,
        symbol: "SPY",
        price: "90",
        sourceDate: today(),
        fetchedAt: new Date(),
        splitState: "safe",
        qualityState: "accepted",
      });
      const [account] = await tx
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.connectionId, connectionId));
      await tx
        .update(schema.accounts)
        .set({ archivedAt: new Date(`${archiveCutoff}T12:00:00Z`), status: "archived" })
        .where(eq(schema.accounts.id, account.id));
    });

    const overview = await getOverview(o.session);
    const history = new Map(overview.netWorthHistory.map((point) => [point.month, point]));
    expect(history.get(firstCutoff.slice(0, 7))).toMatchObject({ amount: "5" });
    expect(history.get(priorMonthEnd(5).slice(0, 7))).toMatchObject({
      amount: "390",
      metadata: { freshness: "stale", qualityFlags: ["carried_forward"] },
    });
    expect(history.get(replacementCutoff.slice(0, 7))).toMatchObject({
      amount: "110",
      metadata: { freshness: "current", qualityFlags: [] },
    });
    expect(history.get(priorMonthEnd(2).slice(0, 7))).toMatchObject({
      amount: "110",
      metadata: { freshness: "stale", qualityFlags: ["carried_forward"] },
    });
    expect(history.get(archiveCutoff.slice(0, 7))).toMatchObject({ amount: "5" });
    expect(overview.netWorth.amount).toBe("5");
  });
});
