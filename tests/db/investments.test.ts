import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import type { Session } from "@/lib/auth/session-store";
import { withUser } from "@/db/client";
import * as schema from "@/db/schema";
import { createUser } from "@/domain/registration";
import { promoteInvestmentSnapshot } from "@/domain/investment-promotion";
import { replaceTiingoQuote } from "@/domain/investment-valuation";
import { decText } from "@/domain/fields";
import {
  getPortfolioHistory,
  getPortfolioOverview,
  getPortfolioSnapshot,
  listPortfolioHoldings,
} from "@/domain/investments";
import { cleanupOwners, elevatedDb } from "./helpers";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN!;
const owners: string[] = [];
afterAll(() => cleanupOwners(owners));

type Owner = { userId: string; dataKey: Buffer; session: Session; connectionIds: string[] };
async function owner(): Promise<Owner> {
  const { userId, dataKey } = await createUser(
    `${randomUUID()}@test.moni`,
    Buffer.from("pw"),
    SIGNUP_TOKEN,
  );
  owners.push(userId);
  return {
    userId,
    dataKey,
    session: {
      id: randomUUID(),
      userId,
      dataKey,
      baseCurrency: "ILS",
      promptSyncOnLogin: false,
      expiresAt: Date.now() + 60_000,
    } as Session,
    connectionIds: [],
  };
}
async function fx(currency: string, day: string, rate: string): Promise<void> {
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
async function connection(o: Owner): Promise<{ connectionId: string; syncRunId: string }> {
  const connectionId = randomUUID();
  const syncRunId = randomUUID();
  o.connectionIds.push(connectionId);
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
  return { connectionId, syncRunId };
}
async function run(o: Owner, connectionId: string): Promise<string> {
  const id = randomUUID();
  await withUser(o.userId, (tx) =>
    tx.insert(schema.syncRuns).values({ id, ownerId: o.userId, connectionId, status: "running" }),
  );
  return id;
}
async function promote(
  o: Owner,
  connectionId: string,
  syncRunId: string,
  ref: string,
  day: string,
  positions: Array<{ id: string; value: string; kind?: "stock" | "etf" }>,
  cash = "0",
): Promise<void> {
  await promoteInvestmentSnapshot({
    userId: o.userId,
    connectionId,
    syncRunId,
    dataKey: o.dataKey,
    envelope: {
      source: "schwab_positions_csv",
      coverage: { kind: "bound_single_account", accountRefs: [ref] },
      sourceAsOf: { value: `${day}T12:00:00Z`, precision: "timestamp" },
      accounts: [
        {
          sourceAccountRef: ref,
          baseCurrency: "USD",
          positions: positions.map((p) => ({
            sourceSecurityId: p.id,
            sourceSecurityIdKind: "schwab_symbol",
            symbol: p.id,
            name: p.id,
            exchange: "NYSE",
            assetKind: p.kind ?? "stock",
            quantity: "1",
            quantityUnit: "shares",
            currency: "USD",
            sourceValue: p.value,
            sourceValueCurrency: "USD",
          })),
          cash: [{ currency: "USD", amount: cash }],
          brokerTotal: {
            amount: positions.reduce((sum, p) => `${BigInt(sum) + BigInt(p.value)}`, cash),
            currency: "USD",
            asOf: `${day}T12:00:00Z`,
          },
        },
      ],
    },
  });
}

async function quote(
  o: Owner,
  symbol: string,
  price: string,
  sourceDate: string,
  splitState: "safe" | "post_split",
): Promise<void> {
  await withUser(o.userId, async (tx) => {
    const mappings = await tx.select().from(schema.instrumentSourceMappings);
    const mapping = mappings.find(
      (row) =>
        row.provider !== "tiingo" &&
        decText(o.dataKey, row.providerSymbolCt, row.id, "provider_symbol_ct", row.version) ===
          symbol,
    );
    if (!mapping) throw new Error(`missing fixture mapping for ${symbol}`);
    await replaceTiingoQuote(tx, o.dataKey, {
      instrumentId: mapping.instrumentId,
      mappingId: mapping.id,
      symbol,
      price,
      sourceDate,
      fetchedAt: new Date(`${sourceDate}T12:00:00Z`),
      splitState,
      qualityState: "accepted",
    });
  });
}

describe("portfolio public reads", () => {
  it("does not overlap queries on the transaction client", async () => {
    const o = await owner();
    await fx("USD", "2026-07-31", "3.5");
    const source = await connection(o);
    await promote(
      o,
      source.connectionId,
      source.syncRunId,
      "****0099",
      "2026-07-31",
      [
        { id: "SERIAL-A", value: "10" },
        { id: "SERIAL-B", value: "20" },
      ],
      "5",
    );

    const warnings: Error[] = [];
    const collect = (warning: Error) => {
      if (warning.message.includes("client.query() when the client is already executing a query"))
        warnings.push(warning);
    };
    process.on("warning", collect);
    try {
      await getPortfolioOverview(o.session);
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      process.off("warning", collect);
    }

    expect(warnings).toEqual([]);
  });

  it("returns exact consolidated overview and filtered stable pages without exposing cursor values", async () => {
    const o = await owner();
    await fx("USD", "2026-07-31", "3.5");
    const a = await connection(o);
    const b = await connection(o);
    await promote(
      o,
      a.connectionId,
      a.syncRunId,
      "****1001",
      "2026-07-31",
      [{ id: "AAA", value: "10" }],
      "-2",
    );
    await promote(
      o,
      b.connectionId,
      b.syncRunId,
      "****2002",
      "2026-07-31",
      [
        { id: "AAA", value: "20" },
        { id: "BBB", value: "5", kind: "etf" },
      ],
      "1",
    );
    const overview = await getPortfolioOverview(o.session);
    expect(overview.ilsValue).toBe("119");
    expect(overview.cashIlsValue).toBe("-3.5");
    expect(overview.allocation).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "AAA", ilsValue: "105" })]),
    );
    expect(overview.allocation.find((row) => row.label === "AAA")?.percentage).toMatch(
      /^88\.23529411764705882352/,
    );
    expect(overview.connections).toHaveLength(2);
    expect(overview.accounts).toHaveLength(2);
    const first = await listPortfolioHoldings(o.session, { limit: 2 });
    expect(first.rows.map((r) => r.ilsValue)).toEqual(["70", "35"]);
    expect(first.nextCursor).not.toContain("70");
    expect(first.nextCursor).not.toContain("AAA");
    const second = await listPortfolioHoldings(o.session, { limit: 2, cursor: first.nextCursor! });
    expect(second.rows).toHaveLength(2);
    expect(
      (await listPortfolioHoldings(o.session, { connectionId: a.connectionId })).rows,
    ).toHaveLength(2);
    expect((await listPortfolioHoldings(o.session, { instrumentKind: "etf" })).rows).toHaveLength(
      1,
    );
    expect((await listPortfolioHoldings(o.session, { kind: "cash" })).rows).toHaveLength(2);
    await expect(
      listPortfolioHoldings(o.session, { limit: 2, cursor: `${first.nextCursor}x` }),
    ).rejects.toThrow("invalid portfolio cursor");
    await expect(
      listPortfolioHoldings(o.session, {
        limit: 2,
        connectionId: a.connectionId,
        cursor: first.nextCursor!,
      }),
    ).rejects.toThrow("invalid portfolio cursor");
    await promote(o, a.connectionId, await run(o, a.connectionId), "****1001", "2026-08-01", [
      { id: "AAA", value: "11" },
    ]);
    await expect(
      listPortfolioHoldings(o.session, { limit: 2, cursor: first.nextCursor! }),
    ).rejects.toThrow("invalid portfolio cursor");
  });

  it("uses one current quote decision across holdings and overview while history stays broker-only", async () => {
    const o = await owner();
    await fx("USD", "2026-07-31", "3.5");
    const quoted = await connection(o);
    const fallback = await connection(o);
    await promote(o, quoted.connectionId, quoted.syncRunId, "****6006", "2026-07-31", [
      { id: "LIVE", value: "10" },
    ]);
    await promote(
      o,
      fallback.connectionId,
      fallback.syncRunId,
      "****7007",
      "2026-07-31",
      [{ id: "SPLIT", value: "7" }],
      "-2",
    );
    await quote(o, "LIVE", "20", "2026-07-31", "safe");
    await quote(o, "SPLIT", "30", "2026-08-01", "post_split");

    const holdings = await listPortfolioHoldings(o.session);
    expect(
      holdings.rows.map((row) => [row.label, row.nativeValue, row.ilsValue, row.basis]),
    ).toEqual([
      ["LIVE", "20", "70", "tiingo_estimate"],
      ["SPLIT", "7", "24.5", "broker_source"],
      ["Cash (USD)", "0", "0", "broker_source"],
      ["Cash (USD)", "-2", "-7", "broker_source"],
    ]);
    expect(holdings.rows[0]).toMatchObject({ sourceAsOf: "2026-07-31", fxAsOf: "2026-07-31" });
    expect(holdings.rows[1].qualityReasons).toContain("quote_fallback");

    const overview = await getPortfolioOverview(o.session);
    expect(overview.ilsValue).toBe("87.5");
    expect(overview.cashIlsValue).toBe("-7");
    expect(overview.cashByCurrency).toEqual([
      { currency: "USD", nativeValue: "-2", ilsValue: "-7" },
    ]);
    expect(overview.allocation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "LIVE",
          ilsValue: "70",
          percentage: expect.stringMatching(/^80$/),
        }),
        expect.objectContaining({
          label: "SPLIT",
          ilsValue: "24.5",
          percentage: expect.stringMatching(/^28$/),
        }),
      ]),
    );
    expect(
      overview.accounts.map((row) => [row.ilsValue, row.metadata.basis, row.metadata.quoteAsOf]),
    ).toEqual([
      ["70", "tiingo_estimate", "2026-07-31"],
      ["17.5", "broker_source", null],
    ]);
    expect(overview.accounts[1].metadata.qualityFlags).toContain("quote_fallback");
    expect(
      overview.connections.map((row) => [
        row.accountCount,
        row.positionCount,
        row.cashCount,
        row.ilsValue,
      ]),
    ).toEqual([
      [1, 1, 1, "70"],
      [1, 1, 1, "17.5"],
    ]);
    expect(overview.metadata).toMatchObject({
      basis: "mixed",
      sourceAsOf: "2026-07-31",
      quoteAsOf: "2026-07-31",
      fxAsOf: "2026-07-31",
      oldestComponentDate: "2026-07-31",
      affectedComponentCount: 1,
      qualityFlags: ["quote_fallback"],
    });

    const history = await getPortfolioHistory(
      o.session,
      { start: "2026-07-26", end: "2026-07-31" },
      "holding",
    );
    expect(history.points.at(-1)?.ilsValue).toBe("52.5");
    expect(history.points.at(-1)?.composition).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "LIVE", ilsValue: "35" }),
        expect.objectContaining({ label: "SPLIT", ilsValue: "24.5" }),
        expect.objectContaining({ label: "Cash (USD)", ilsValue: "-7" }),
      ]),
    );
  });

  it("keeps historical broker state separate from estimates, carries whole accounts, and pages selected-week composition", async () => {
    const o = await owner();
    await fx("USD", "2026-07-05", "3");
    await fx("USD", "2026-07-12", "3");
    await fx("USD", "2026-07-19", "3");
    await fx("USD", "2026-07-26", "3");
    const c = await connection(o);
    await promote(o, c.connectionId, c.syncRunId, "****3003", "2026-07-26", [
      { id: "OLD", value: "10" },
    ]);
    await withUser(o.userId, (tx) =>
      tx
        .update(schema.investmentSnapshotDetails)
        .set({ weekStart: "2026-07-05", sourceAsOf: new Date("2026-07-05T12:00:00Z") }),
    );
    await promote(
      o,
      c.connectionId,
      await run(o, c.connectionId),
      "****3003",
      "2026-07-26",
      [{ id: "NEW", value: "20" }],
      "2",
    );
    await withUser(o.userId, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.investmentSnapshotDetails)
        .orderBy(schema.investmentSnapshotDetails.weekStart);
      await tx
        .update(schema.investmentSnapshotDetails)
        .set({ weekStart: "2026-07-19", sourceAsOf: new Date("2026-07-19T12:00:00Z") })
        .where(eq(schema.investmentSnapshotDetails.id, rows[1].id));
    });
    const history = await getPortfolioHistory(
      o.session,
      { start: "2026-07-05", end: "2026-07-19" },
      "holding",
    );
    expect(history.points.map((p) => p.week)).toEqual(["2026-07-05", "2026-07-12", "2026-07-19"]);
    expect(history.points.map((p) => p.ilsValue)).toEqual(["30", "30", "66"]);
    expect(history.points[2].composition.map((x) => x.label)).not.toContain("OLD");
    expect(history.valuationChange).toEqual({
      label: "Valuation change",
      disclosure: "Includes deposits and withdrawals",
      amount: "36",
      percentage: "120",
    });
    expect(history.estimatedNow?.ilsValue).toBe("66");
    const snapshot = await getPortfolioSnapshot(o.session, "2026-07-12", { limit: 1 });
    expect(snapshot.week).toBe("2026-07-12");
    expect(snapshot.rows[0].sourceAsOf).toBe("2026-07-05");
    expect(snapshot.rows[0].qualityReasons).toContain("carried_forward");
    expect(snapshot.hasMore).toBe(true);
    expect(
      (
        await getPortfolioSnapshot(o.session, "2026-07-12", {
          limit: 1,
          cursor: snapshot.nextCursor!,
        })
      ).rows,
    ).toHaveLength(1);
  });

  it("cannot use direct foreign ids, weeks, cursors, or aggregates to reveal another tenant", async () => {
    const a = await owner();
    const b = await owner();
    await fx("USD", "2026-07-31", "3");
    const ca = await connection(a);
    const cb = await connection(b);
    await promote(a, ca.connectionId, ca.syncRunId, "****4004", "2026-07-31", [
      { id: "SECRET", value: "9" },
    ]);
    await promote(b, cb.connectionId, cb.syncRunId, "****5005", "2026-07-31", [
      { id: "OTHER", value: "8" },
    ]);
    const foreign = await listPortfolioHoldings(b.session, { connectionId: ca.connectionId });
    expect(foreign.rows).toEqual([]);
    const accountId = (await getPortfolioOverview(a.session)).accounts[0].id;
    expect((await listPortfolioHoldings(b.session, { accountId })).rows).toEqual([]);
    expect(
      (await getPortfolioSnapshot(b.session, "2026-07-31")).rows.every(
        (row) => row.label !== "SECRET",
      ),
    ).toBe(true);
    const cursor = (await listPortfolioHoldings(a.session, { limit: 1 })).nextCursor!;
    await expect(listPortfolioHoldings(b.session, { limit: 1, cursor })).rejects.toThrow(
      "invalid portfolio cursor",
    );
    expect(
      (
        await getPortfolioHistory(b.session, { start: "2026-07-26", end: "2026-07-31" }, "account")
      ).points.at(-1)?.ilsValue,
    ).toBe("28");
  });

  it("keeps the public portfolio read module free of fetch and provider imports", async () => {
    const source = await readFile(
      new URL("../../src/domain/investments.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/\bfetch\b|from\s+["'][^"']*(tiingo|ibkr|schwab)/i);
  });
});
