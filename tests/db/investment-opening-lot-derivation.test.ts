import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withUser } from "@/db/client";
import * as schema from "@/db/schema";
import { decText, encText } from "@/domain/fields";
import { deriveInvestmentTaxLots } from "@/domain/investment-lots";
import { getDevUserDataKey } from "@/lib/crypto";
import { cleanupOwners, elevatedDb, elevatedPool } from "./helpers";

// Opening lots next to stored activity: IBKR's OpenPosition lot for a buy that
// is already stored must not become a second acquisition, and a separately
// stated fee belongs in the lot's cost basis.
describe("opening-lot derivation", () => {
  let userId: string;
  let accountId: string;
  let instrumentId: string;

  beforeAll(async () => {
    const [user] = await elevatedDb
      .insert(schema.users)
      .values({ email: `opening-derivation-${randomUUID()}@test.moni` })
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
    const dataKey = getDevUserDataKey(userId);
    try {
      accountId = randomUUID();
      await elevatedDb.insert(schema.accounts).values({
        id: accountId,
        ownerId: userId,
        connectionId: connection.id,
        accountType: "investment",
        classification: "asset",
        nameCt: encText(dataKey, "Opening derivation", accountId, "name_ct", 1),
        currency: "XAA",
      });
      const [instrument] = await elevatedDb
        .insert(schema.instruments)
        .values({ ownerId: userId, kind: "stock" })
        .returning({ id: schema.instruments.id });
      instrumentId = instrument.id;

      // A buy stored by an earlier sync, identified by IBKR's transactionID.
      const buyId = randomUUID();
      await elevatedDb.insert(schema.investmentActivityEvidence).values({
        id: buyId,
        ownerId: userId,
        connectionId: connection.id,
        syncRunId: run.id,
        accountId,
        instrumentId,
        source: "ibkr_flex",
        activityType: "buy",
        providerActivityIdCt: encText(dataKey, "TXN-1", buyId, "provider_activity_id_ct", 1),
        idempotencyKey: Buffer.from(`opening-derivation-${buyId}`),
        tradeDate: "2026-03-02",
        quantityCt: encText(dataKey, "5", buyId, "quantity_ct", 1),
        quantityUnit: "shares",
        priceCt: encText(dataKey, "10", buyId, "price_ct", 1),
        grossAmountCt: encText(dataKey, "-50", buyId, "gross_amount_ct", 1),
        currency: "XAA",
        rawTypeCt: encText(dataKey, "Trade", buyId, "raw_type_ct", 1),
        provenance: "broker_reported",
      });

      const opening = async (lotId: string, quantity: string, cost: string, fees?: string) => {
        const id = randomUUID();
        await elevatedDb.insert(schema.investmentOpeningLotEvidence).values({
          id,
          ownerId: userId,
          accountId,
          instrumentId,
          idempotencyKey: Buffer.from(`opening-derivation-${id}`),
          brokerLotIdCt: encText(dataKey, lotId, id, "broker_lot_id_ct", 1),
          tradeDate: "2026-03-02",
          originalQuantityCt: encText(dataKey, quantity, id, "original_quantity_ct", 1),
          remainingQuantityCt: encText(dataKey, quantity, id, "remaining_quantity_ct", 1),
          quantityUnit: "shares",
          totalCostCt: encText(dataKey, cost, id, "total_cost_ct", 1),
          feesCt: fees ? encText(dataKey, fees, id, "fees_ct", 1) : null,
          currency: "XAA",
          lockedFxProvenance: "unresolved",
          provenance: "broker_reported",
        });
      };
      // A later statement's OpenPosition lot for that same buy...
      await opening("TXN-1", "5", "50");
      // ...and a genuinely older lot carrying its commission separately.
      await opening("OLD-LOT", "2", "20", "1.5");
    } finally {
      dataKey.fill(0);
    }
  });

  afterAll(async () => {
    await cleanupOwners([userId]);
    await elevatedPool.end();
  });

  it("counts a stored buy once and adds an opening lot's fee to its cost basis", async () => {
    const dataKey = getDevUserDataKey(userId);
    try {
      await deriveInvestmentTaxLots({ userId, accountId, instrumentId, dataKey });
      const lots = await withUser(userId, (tx) => tx.select().from(schema.investmentTaxLots));
      const costs = lots
        .map((lot) => ({
          fromActivity: lot.acquisitionActivityId !== null,
          costBasis: decText(dataKey, lot.costBasisCt, lot.id, "cost_basis_ct", lot.version),
        }))
        .sort((left, right) => Number(right.fromActivity) - Number(left.fromActivity));
      expect(costs).toEqual([
        { fromActivity: true, costBasis: "50" },
        { fromActivity: false, costBasis: "21.5" },
      ]);
    } finally {
      dataKey.fill(0);
    }
  });
});
