import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withUser } from "@/db/client";
import * as schema from "@/db/schema";
import {
  InvestmentResolutionError,
  readInvestmentActivity,
  resolveDisposal,
} from "@/domain/investment-activity-resolution";
import { encText } from "@/domain/fields";
import { deriveInvestmentTaxLots } from "@/domain/investment-lots";
import { upsertBoiFxRate } from "@/domain/fx-rates";
import { decryptField, getDevUserDataKey } from "@/lib/crypto";
import type { Session } from "@/lib/auth/session-store";
import { cleanupFxRates, cleanupOwners, elevatedDb, elevatedPool } from "./helpers";

describe("investment activity resolution", () => {
  let userId: string;
  let accountId: string;
  let instrumentId: string;
  let queueId: string;
  const fxRateIds: string[] = [];

  beforeAll(async () => {
    const [user] = await elevatedDb
      .insert(schema.users)
      .values({ email: `activity-resolution-${randomUUID()}@test.moni` })
      .returning({ id: schema.users.id });
    userId = user.id;
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
    accountId = randomUUID();
    instrumentId = randomUUID();
    const dataKey = getDevUserDataKey(userId);
    try {
      await elevatedDb.insert(schema.accounts).values({
        id: accountId,
        ownerId: userId,
        connectionId: connection.id,
        accountType: "investment",
        classification: "asset",
        nameCt: encText(dataKey, "Resolution account", accountId, "name_ct", 1),
        externalAccountRefCt: encText(
          dataKey,
          "RESOLVE-135",
          accountId,
          "external_account_ref_ct",
          1,
        ),
        currency: "XAA",
        status: "active",
      });
      await elevatedDb.insert(schema.instruments).values({
        id: instrumentId,
        ownerId: userId,
        kind: "stock",
        canonicalSymbolCt: encText(dataKey, "EXACT", instrumentId, "canonical_symbol_ct", 1),
      });
      for (const [index, quantity, cost] of [
        [1, "3", "30"],
        [2, "2", "40"],
      ] as const) {
        const id = randomUUID();
        await elevatedDb.insert(schema.investmentOpeningLotEvidence).values({
          id,
          ownerId: userId,
          accountId,
          instrumentId,
          idempotencyKey: Buffer.from(`resolution-opening-${index}`),
          tradeDate: `2026-09-0${index}`,
          originalQuantityCt: encText(dataKey, quantity, id, "original_quantity_ct", 1),
          remainingQuantityCt: encText(dataKey, quantity, id, "remaining_quantity_ct", 1),
          quantityUnit: "shares",
          totalCostCt: encText(dataKey, cost, id, "total_cost_ct", 1),
          currency: "XAA",
          lockedFxRateCt: encText(dataKey, "3", id, "locked_fx_rate_ct", 1),
          lockedFxConvention: "ILS_PER_XAA",
          lockedFxObservationDate: `2026-09-0${index}`,
          lockedFxProvenance: "user_entered",
          provenance: "user_entered",
        });
      }
      const saleId = randomUUID();
      await elevatedDb.insert(schema.investmentActivityEvidence).values({
        id: saleId,
        ownerId: userId,
        connectionId: connection.id,
        syncRunId: run.id,
        accountId,
        instrumentId,
        source: "ibkr_flex",
        activityType: "sell",
        idempotencyKey: Buffer.from("resolution-sale"),
        tradeDate: "2026-09-10",
        quantityCt: encText(dataKey, "-4", saleId, "quantity_ct", 1),
        quantityUnit: "shares",
        grossAmountCt: encText(dataKey, "60", saleId, "gross_amount_ct", 1),
        feeAmountCt: encText(dataKey, "2", saleId, "fee_amount_ct", 1),
        currency: "XAA",
        rawTypeCt: encText(dataKey, "Trade", saleId, "raw_type_ct", 1),
        provenance: "broker_reported",
      });
      await deriveInvestmentTaxLots({ userId, accountId, instrumentId, dataKey });
    } finally {
      dataKey.fill(0);
    }
    await upsertBoiFxRate({ fromCurrency: "XAA", date: "2026-09-10", rate: "4" });
    fxRateIds.push(
      ...(
        await elevatedDb
          .select({ id: schema.fxRates.id })
          .from(schema.fxRates)
          .where(eq(schema.fxRates.fromCurrency, "XAA"))
      ).map((row) => row.id),
    );
    const [queue] = await withUser(userId, (tx) =>
      tx
        .select()
        .from(schema.investmentDisposalResolutionQueue)
        .where(eq(schema.investmentDisposalResolutionQueue.kind, "unresolved_disposal")),
    );
    queueId = queue.id;
  });

  afterAll(async () => {
    await cleanupOwners([userId]);
    await cleanupFxRates(fxRateIds);
    await elevatedPool.end();
  });

  async function withSession<T>(fn: (session: Session) => Promise<T>): Promise<T> {
    const dataKey = Buffer.from(getDevUserDataKey(userId));
    try {
      return await fn({
        id: "test-session",
        userId,
        dataKey,
        baseCurrency: "ILS",
        syncPromptDismissed: false,
        expiresAt: Date.now() + 60_000,
      });
    } finally {
      dataKey.fill(0);
    }
  }

  it("blocks a partial allocation and leaves the sale pending", async () => {
    const view = await withSession(readInvestmentActivity);
    expect(view.pendingCount).toBe(1);
    expect(view.pending[0]).toMatchObject({
      id: queueId,
      kindLabel: "Sale",
      accountName: "Resolution account",
      instrumentLabel: "EXACT",
      sale: { quantity: "4", proceeds: "58" },
    });
    const lotId = view.pending[0].sale!.eligibleLots[0].id;
    await expect(
      withSession((session) => resolveDisposal(session, queueId, [{ lotId, quantity: "3" }])),
    ).rejects.toEqual(
      expect.objectContaining<Partial<InvestmentResolutionError>>({ code: "invalid_allocation" }),
    );
    await expect(
      withUser(userId, (tx) =>
        tx
          .select({ status: schema.investmentDisposalResolutionQueue.status })
          .from(schema.investmentDisposalResolutionQueue)
          .where(eq(schema.investmentDisposalResolutionQueue.id, queueId)),
      ),
    ).resolves.toEqual([{ status: "pending" }]);
  });

  it("commits exact user-selected closures, preserves the audit row, and replays byte-stably", async () => {
    const before = await withSession(readInvestmentActivity);
    const [first, second] = before.pending[0].sale!.eligibleLots;
    const result = await withSession((session) =>
      resolveDisposal(session, queueId, [
        { lotId: first.id, quantity: "3" },
        { lotId: second.id, quantity: "1" },
      ]),
    );
    expect(result.preview).toMatchObject({
      saleQuantity: "4",
      allocatedQuantity: "4",
      nativeProceeds: "58",
      nativeRealizedCostBasis: "50",
      ilsGainIncludesFx: "82",
    });

    const stored = await withUser(userId, async (tx) => ({
      queue: await tx
        .select()
        .from(schema.investmentDisposalResolutionQueue)
        .where(eq(schema.investmentDisposalResolutionQueue.id, queueId)),
      closures: await tx.select().from(schema.investmentLotClosures),
      lots: await tx.select().from(schema.investmentTaxLots),
    }));
    expect(stored.queue).toHaveLength(1);
    expect(stored.queue[0].status).toBe("resolved");
    expect(stored.closures).toHaveLength(2);
    expect(stored.closures.every((row) => row.allocationProvenance === "user_selected")).toBe(true);
    const dataKey = getDevUserDataKey(userId);
    try {
      expect(
        stored.closures
          .map((row) =>
            decryptField(dataKey, row.realizedCostBasisCt, {
              rowId: row.id,
              column: "realized_cost_basis_ct",
              version: row.version,
            }).toString("utf8"),
          )
          .sort(),
      ).toEqual(["20", "30"]);
    } finally {
      dataKey.fill(0);
    }

    await withSession((session) =>
      deriveInvestmentTaxLots({ userId, accountId, instrumentId, dataKey: session.dataKey }),
    );
    const replay = await withUser(userId, async (tx) => ({
      queue: await tx
        .select()
        .from(schema.investmentDisposalResolutionQueue)
        .where(eq(schema.investmentDisposalResolutionQueue.id, queueId)),
      closures: await tx.select().from(schema.investmentLotClosures),
      lots: await tx.select().from(schema.investmentTaxLots),
    }));
    expect(replay).toEqual(stored);
    const activity = await withSession(readInvestmentActivity);
    expect(activity.pendingCount).toBe(0);
    expect(activity.recentlyResolved[0]).toMatchObject({ id: queueId, status: "resolved" });

    await expect(
      withSession((session) =>
        resolveDisposal(session, queueId, [
          { lotId: first.id, quantity: "3" },
          { lotId: second.id, quantity: "1" },
        ]),
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<InvestmentResolutionError>>({ code: "already_resolved" }),
    );
  });
});
