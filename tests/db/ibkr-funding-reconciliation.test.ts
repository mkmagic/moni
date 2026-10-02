import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { withUser } from "@/db/client";
import * as schema from "@/db/schema";
import { decText } from "@/domain/fields";
import { ingestInvestmentActivityEvidence } from "@/domain/investment-activity";
import { deriveAndReconcileInvestmentActivity } from "@/domain/investment-activity-sync";
import { promoteInvestmentSnapshot } from "@/domain/investment-promotion";
import { readInvestmentDividendIncome } from "@/domain/investment-returns";
import { readInvestmentActivity } from "@/domain/investment-activity-resolution";
import { getDevUserDataKey } from "@/lib/crypto";
import {
  normalizeIbkrFlexActivityXml,
  normalizeIbkrFlexXml,
  requiredBoiPairs,
} from "@/lib/investments";
import { cleanupFxRates, cleanupOwners, elevatedDb, elevatedPool } from "./helpers";

const owners: string[] = [];
const fxIds: string[] = [];
afterAll(async () => {
  await cleanupOwners(owners);
  await cleanupFxRates(fxIds);
  await elevatedPool.end();
});

describe("IBKR funding replay", () => {
  it("repairs former FX security lots and reconciles both cash currencies without duplicating dividends", async () => {
    const [user] = await elevatedDb
      .insert(schema.users)
      .values({ email: `funding-${randomUUID()}@test.moni` })
      .returning();
    owners.push(user.id);
    const [connection] = await elevatedDb
      .insert(schema.connections)
      .values({
        ownerId: user.id,
        connectorId: "ibkr_flex",
        credentialsCt: Buffer.from("test-only"),
        status: "active",
      })
      .returning();
    const dataKey = getDevUserDataKey(user.id);
    const key = Buffer.from("funding-fingerprint-test");
    try {
      const xml = readFileSync(
        new URL("../fixtures/investments/ibkr-flex-ils-funding.xml", import.meta.url),
        "utf8",
      ).replaceAll("2026", "2039");
      const envelope = normalizeIbkrFlexXml(xml);
      const evidence = normalizeIbkrFlexActivityXml(xml, key);
      for (const pair of requiredBoiPairs(envelope, evidence)) {
        const rows = await elevatedDb
          .insert(schema.fxRates)
          .values({
            fromCurrency: pair.currency,
            toCurrency: "ILS",
            date: pair.date,
            rate: "4",
            source: "boi",
          })
          .onConflictDoNothing()
          .returning({ id: schema.fxRates.id });
        fxIds.push(...rows.map((row) => row.id));
      }
      const run = async () => {
        const [row] = await elevatedDb
          .insert(schema.syncRuns)
          .values({
            ownerId: user.id,
            connectionId: connection.id,
            status: "running",
          })
          .returning();
        return row.id;
      };
      const input = { userId: user.id, connectionId: connection.id, dataKey };
      await promoteInvestmentSnapshot({ ...input, syncRunId: await run(), envelope });
      const syncRunId = await run();
      // Reproduce the parser shipped before this fix: every FX execution was
      // a buy of currency "shares", with no cash legs when netCash was absent.
      const legacy = normalizeIbkrFlexActivityXml(
        xml.replaceAll('assetCategory="CASH"', 'assetCategory="STK"'),
        key,
      );
      await ingestInvestmentActivityEvidence({ ...input, syncRunId, evidence: legacy });
      await deriveAndReconcileInvestmentActivity(input);
      expect(
        await withUser(user.id, (tx) => tx.select().from(schema.investmentTaxLots)),
      ).toHaveLength(6);

      await ingestInvestmentActivityEvidence({ ...input, syncRunId, evidence });
      // A later sync promotes a NEW snapshot. Old warnings must not remain in
      // the current review queue when its corrected activity reconciles.
      await promoteInvestmentSnapshot({
        ...input,
        syncRunId: await run(),
        envelope: normalizeIbkrFlexXml(xml.replaceAll("20390901", "20390908")),
      });
      await deriveAndReconcileInvestmentActivity(input);
      const read = () =>
        withUser(user.id, async (tx) => ({
          accounts: await tx.select().from(schema.accounts),
          lots: await tx.select().from(schema.investmentTaxLots),
          quality: await tx.select().from(schema.investmentReconciliationQuality),
          activity: await tx.select().from(schema.investmentActivityEvidence),
          coverage: await tx.select().from(schema.investmentActivityCoverage),
        }));
      const stored = await read();
      expect(stored.lots).toHaveLength(3);
      expect(stored.coverage.filter((row) => row.metric === "cost_basis")).toHaveLength(1);
      expect(
        stored.lots
          .map((row) =>
            decText(dataKey, row.remainingQuantityCt, row.id, "remaining_quantity_ct", row.version),
          )
          .sort(),
      ).toEqual(["100", "50", "50"]);
      expect(
        stored.quality.filter(
          (row) =>
            row.status === "pending" &&
            ["position_quantity", "cash_balance"].includes(row.dimension),
        ),
      ).toEqual([]);
      expect(stored.activity.filter((row) => row.activityType === "dividend")).toHaveLength(1);
      const dividend = await readInvestmentDividendIncome({
        userId: user.id,
        dataKey,
        accountId: stored.accounts[0].id,
      });
      expect(dividend.native).toEqual([
        { amount: "20", currency: "USD", basis: "booked_cash_income" },
      ]);
      expect(dividend.ils.amount).toBe("80");
      expect(dividend.quality.completeness).toBe("unknown");
      expect(dividend.ilsAvailable).toBe(true);
      expect(dividend.events).toEqual([
        expect.objectContaining({
          date: "2039-06-20",
          accountId: stored.accounts[0].id,
          native: { amount: "20", currency: "USD", basis: "booked_cash_income" },
          ils: { amount: "80", currency: "ILS", basis: "booked_cash_income" },
        }),
      ]);
      // Old installs can already contain pending warnings for superseded
      // snapshots. Current reads must work without requiring another sync.
      const oldQualityIds = stored.quality.map((row) => row.id);
      await elevatedDb
        .update(schema.investmentReconciliationQuality)
        .set({ status: "pending", resolvedAt: null })
        .where(inArray(schema.investmentReconciliationQuality.id, oldQualityIds));
      await elevatedDb
        .update(schema.investmentDisposalResolutionQueue)
        .set({ status: "pending", resolvedAt: null })
        .where(
          inArray(schema.investmentDisposalResolutionQueue.reconciliationQualityId, oldQualityIds),
        );
      const currentActivity = await readInvestmentActivity({
        id: "funding-test-session",
        userId: user.id,
        dataKey: Buffer.from(dataKey.buffer, dataKey.byteOffset, dataKey.byteLength),
        baseCurrency: "ILS",
        syncPromptDismissed: false,
        expiresAt: Date.now() + 60_000,
      });
      expect(currentActivity.pendingCount).toBe(0);
      await ingestInvestmentActivityEvidence({ ...input, syncRunId, evidence });
      await deriveAndReconcileInvestmentActivity(input);
      const replay = await read();
      expect(replay.lots).toEqual(stored.lots);
      expect(replay.activity).toEqual(stored.activity);

      // A native payment stays inspectable when its conversion rate is absent;
      // the converted subtotal must not be advertised as the full ILS total.
      const missingFx = {
        ...evidence.activities.find((row) => row.activityType === "dividend")!,
        idempotencyKey: "missing-fx-dividend",
        sourceActivityId: "missing-fx-dividend",
        sourceSecurityId: undefined,
        sourceSecurityIdKind: undefined,
        tradeDate: "2039-06-21",
        currency: "XNF",
        grossAmount: "5",
        netCashAmount: "5",
      };
      await ingestInvestmentActivityEvidence({
        ...input,
        syncRunId,
        evidence: { ...evidence, activities: [missingFx] },
      });
      const unconverted = await readInvestmentDividendIncome({
        userId: user.id,
        dataKey,
        accountId: stored.accounts[0].id,
      });
      expect(unconverted.ilsAvailable).toBe(false);
      expect(unconverted.bookedCashCount).toBe(2);
      expect(
        unconverted.events.map((event) => [
          event.date,
          event.native.amount,
          event.ils?.amount ?? null,
        ]),
      ).toEqual([
        ["2039-06-20", "20", "80"],
        ["2039-06-21", "5", null],
      ]);
    } finally {
      dataKey.fill(0);
      key.fill(0);
    }
  });
});
