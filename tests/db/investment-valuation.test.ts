import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { withUser } from "@/db/client";
import * as schema from "@/db/schema";
import { promoteInvestmentSnapshot } from "@/domain/investment-promotion";
import {
  listTiingoQuoteTargets,
  replaceTiingoQuote,
  valueInvestmentSnapshot,
} from "@/domain/investment-valuation";
import { createUser } from "@/domain/registration";
import { cleanupOwners, elevatedDb } from "./helpers";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN;
if (!SIGNUP_TOKEN) throw new Error("MONI_SIGNUP_TOKEN must be set in the test environment");
const owners: string[] = [];

afterAll(() => cleanupOwners(owners));

describe("investment valuation", () => {
  it("prefers broker market value, includes signed cash, converts with source-date BOI, then uses a usable Tiingo estimate", async () => {
    const { userId, dataKey } = await createUser(
      `${randomUUID()}@test.moni`,
      Buffer.from("test password"),
      SIGNUP_TOKEN!,
    );
    owners.push(userId);
    const connectionId = randomUUID();
    const syncRunId = randomUUID();
    await withUser(userId, async (tx) => {
      await tx.insert(schema.connections).values({
        id: connectionId,
        ownerId: userId,
        connectorId: "schwab_positions_csv",
        mode: "user_mediated_import",
        credentialsCt: null,
        status: "active",
      });
      await tx.insert(schema.syncRuns).values({
        id: syncRunId,
        ownerId: userId,
        connectionId,
        status: "running",
      });
    });
    await elevatedDb
      .insert(schema.fxRates)
      .values({
        id: randomUUID(),
        fromCurrency: "USD",
        toCurrency: "ILS",
        date: "2026-07-31",
        rate: "3.5",
        source: "boi",
      })
      .onConflictDoNothing();
    await promoteInvestmentSnapshot({
      userId,
      connectionId,
      syncRunId,
      dataKey,
      envelope: {
        source: "schwab_positions_csv",
        coverage: { kind: "bound_single_account", accountRefs: ["****1234"] },
        sourceAsOf: { value: "2026-07-31T10:00:00Z", precision: "timestamp" },
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
                quantity: "2",
                quantityUnit: "shares",
                currency: "USD",
                sourcePrice: "12",
                sourcePriceCurrency: "USD",
                sourceValue: "100",
                sourceValueCurrency: "USD",
              },
            ],
            cash: [{ currency: "USD", amount: "-5" }],
            brokerTotal: { amount: "95", currency: "USD", asOf: "2026-07-31T10:00:00Z" },
          },
        ],
      },
    });
    await withUser(userId, async (tx) => {
      const [detail] = await tx.select().from(schema.investmentSnapshotDetails);
      expect(
        (await valueInvestmentSnapshot(tx, dataKey, detail.id, { now: new Date("2026-08-01") }))
          .ilsValue,
      ).toBe("332.5");
      const [position] = await tx.select().from(schema.investmentSnapshotPositions);
      const [mapping] = await tx
        .select()
        .from(schema.instrumentSourceMappings)
        .where(eq(schema.instrumentSourceMappings.instrumentId, position.instrumentId));
      await replaceTiingoQuote(tx, dataKey, {
        instrumentId: position.instrumentId,
        mappingId: mapping.id,
        symbol: "SPY",
        price: "20.000000000000000001",
        sourceDate: "2026-08-01",
        fetchedAt: new Date("2026-08-01T12:00:00Z"),
        splitState: "safe",
        qualityState: "accepted",
      });
      await replaceTiingoQuote(tx, dataKey, {
        instrumentId: position.instrumentId,
        mappingId: mapping.id,
        symbol: "SPY",
        price: "21.000000000000000001",
        sourceDate: "2026-08-01",
        fetchedAt: new Date("2026-08-01T12:01:00Z"),
        splitState: "safe",
        qualityState: "accepted",
      });
      const estimate = await valueInvestmentSnapshot(tx, dataKey, detail.id, {
        estimateNow: true,
        now: new Date("2026-08-01"),
      });
      expect(estimate.ilsValue).toBe("129.500000000000000007");
      expect(estimate.metadata.basis).toBe("tiingo_estimate");
      const quoteRows = await tx
        .select()
        .from(schema.investmentMarketQuotes)
        .where(
          and(
            eq(schema.investmentMarketQuotes.instrumentId, position.instrumentId),
            eq(schema.investmentMarketQuotes.provider, "tiingo"),
          ),
        );
      expect(quoteRows).toHaveLength(1);
      expect(quoteRows[0].priceCt.equals(Buffer.from("21.000000000000000001"))).toBe(false);
      await tx
        .update(schema.investmentMarketQuotes)
        .set({ splitState: "post_split" })
        .where(eq(schema.investmentMarketQuotes.id, quoteRows[0].id));
      expect(
        (
          await valueInvestmentSnapshot(tx, dataKey, detail.id, {
            estimateNow: true,
            now: new Date("2026-08-01"),
          })
        ).metadata.qualityFlags,
      ).toContain("quote_fallback");
      await tx
        .update(schema.investmentSnapshotPositions)
        .set({ sourceAsOf: new Date("2026-08-01T00:00:00Z") })
        .where(eq(schema.investmentSnapshotPositions.id, position.id));
      expect(
        (
          await valueInvestmentSnapshot(tx, dataKey, detail.id, {
            estimateNow: true,
            now: new Date("2026-08-01"),
          })
        ).metadata.basis,
      ).toBe("tiingo_estimate");
      expect(await listTiingoQuoteTargets(tx, dataKey)).toEqual([
        { instrumentId: position.instrumentId, mappingId: mapping.id, symbol: "SPY" },
      ]);
      const quoteCount = (await tx.select().from(schema.investmentMarketQuotes)).length;
      const mappingCount = (await tx.select().from(schema.instrumentSourceMappings)).length;
      await expect(
        replaceTiingoQuote(tx, dataKey, {
          instrumentId: randomUUID(),
          mappingId: mapping.id,
          symbol: "SPY",
          price: "1",
          sourceDate: "2026-08-01",
          fetchedAt: new Date("2026-08-01"),
          splitState: "safe",
          qualityState: "accepted",
        }),
      ).rejects.toThrow("Tiingo source mapping not found");
      expect((await tx.select().from(schema.investmentMarketQuotes)).length).toBe(quoteCount);
      expect((await tx.select().from(schema.instrumentSourceMappings)).length).toBe(mappingCount);

      const [cashRow] = await tx.select().from(schema.investmentSnapshotCashBalances);
      await tx
        .update(schema.investmentSnapshotCashBalances)
        .set({ currency: "EUR" })
        .where(eq(schema.investmentSnapshotCashBalances.id, cashRow.id));
      const mixedNative = await valueInvestmentSnapshot(tx, dataKey, detail.id, {
        now: new Date("2026-08-01"),
      });
      expect(mixedNative).toMatchObject({ ilsValue: "350", nativeValue: null, currency: null });
      expect(mixedNative.metadata).toMatchObject({
        affectedComponentCount: 1,
        qualityFlags: ["incomplete_fx"],
      });

      await tx
        .update(schema.investmentSnapshotPositions)
        .set({ currency: "EUR", sourceValueCurrency: "EUR" })
        .where(eq(schema.investmentSnapshotPositions.id, position.id));
      const singleMissingFx = await valueInvestmentSnapshot(tx, dataKey, detail.id, {
        now: new Date("2026-08-01"),
      });
      expect(singleMissingFx).toMatchObject({ ilsValue: "0", nativeValue: "95", currency: "EUR" });
      expect(singleMissingFx.metadata).toMatchObject({
        affectedComponentCount: 2,
        qualityFlags: ["incomplete_fx"],
      });
    });
    dataKey.fill(0);
  });
});
