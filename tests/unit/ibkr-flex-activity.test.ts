import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { normalizeIbkrFlexActivityXml, normalizeIbkrFlexXml } from "@/lib/investments";

const fixtureUrl = new URL(
  "../fixtures/investments/ibkr-flex-activity-redacted.xml",
  import.meta.url,
);
const xml = readFileSync(fixtureUrl, "utf8");

function parseActivity() {
  const key = Buffer.from("ibkr-activity-test-fingerprint-key");
  try {
    return normalizeIbkrFlexActivityXml(xml, key);
  } finally {
    key.fill(0);
  }
}

describe("IBKR Flex activity evidence", () => {
  it("keeps execution identity, individual fills, signs, and correction evidence", () => {
    const { activities } = parseActivity();
    const trades = activities.filter((activity) => activity.rawType === "Trade");

    expect(trades).toHaveLength(3);
    expect(trades.every((trade) => trade.sourceExecutionId || trade.sourceTradeId)).toBe(true);
    expect(trades.slice(0, 2).map((trade) => trade.sourceOrderId)).toEqual(["ORDER-1", "ORDER-1"]);
    expect(trades.slice(0, 2).map((trade) => trade.sourceExecutionId)).toEqual([
      "EXEC-1",
      "EXEC-2",
    ]);
    expect(trades[0]).toMatchObject({
      activityType: "buy",
      occurredAt: "2025-03-10T15:30:00",
      settlementDate: "2025-03-12",
      quantity: "5",
      price: "200",
      grossAmount: "-1000",
      feeAmount: "-1",
      taxAmount: "0",
      netCashAmount: "-1001",
    });
    expect(trades[2]).toMatchObject({
      activityType: "sell",
      sourceRevisionOfId: "TRADE-OLD",
      brokerOpenDateTime: "20250310;153000",
      rawCode: "C;Ca",
      rawDescription: "Corrected trade",
      quantity: "-1",
      grossAmount: "210",
      taxAmount: "-0.25",
    });
    expect(trades[2].brokerLotAllocations).toBeUndefined();
  });

  it("normalizes only LOT detail as broker-reported opening-lot evidence", () => {
    const { openLots } = parseActivity();

    expect(openLots).toHaveLength(2);
    expect(openLots[0]).toMatchObject({
      sourceLotId: "LOT-1",
      tradeDate: "2025-03-10",
      remainingQuantity: "4",
      unitCost: "200.2",
      totalCost: "800.8",
      provenance: "broker_reported",
    });
    expect(openLots[1].sourceLotId).toMatch(/^ibkr:lot:fp:/);
    expect(openLots[1]).toMatchObject({
      tradeDate: "2025-03-10",
      remainingQuantity: "5",
      unitCost: "201.2",
      totalCost: "1006",
    });
  });

  it("classifies booked cash while keeping the accrual linked and non-paying", () => {
    const evidence = parseActivity();
    const cash = evidence.activities.filter((activity) => activity.rawType !== "Trade");

    expect(cash.map((activity) => activity.activityType)).toEqual([
      "dividend",
      "tax",
      "dividend",
      "interest",
      "fee",
      "deposit",
      "withdrawal",
    ]);
    expect(evidence.dividendAccruals).toEqual([
      expect.objectContaining({
        payDate: "2025-05-15",
        grossAmount: "23",
        withholdingTaxAmount: "3.45",
        feeAmount: "0",
        netAmount: "19.55",
        linkedCashActivityId: "REDACTED-ACCOUNT:cash:CASH-1",
      }),
    ]);
    expect(evidence.activities).toHaveLength(10);
    expect(
      evidence.activities.filter(
        (activity) => activity.activityType === "dividend" && activity.tradeDate === "2025-05-15",
      ),
    ).toHaveLength(1);
  });

  it("retains every corporate action without synthesizing activity or lot math", () => {
    const evidence = parseActivity();

    expect(evidence.corporateActions).toEqual([
      expect.objectContaining({
        sourceActionId: "CORP-1",
        rawType: "FS",
        rawCode: "FS",
        rawDescription: "Forward split",
        quantity: "10",
        proceeds: "0",
        classification: "UNSUPPORTED_CORPORATE_ACTION",
      }),
    ]);
    expect(evidence.activities.some((activity) => activity.idempotencyKey.includes("CORP-1"))).toBe(
      false,
    );
  });

  it("is replay-stable, including keyed fallback fingerprints", () => {
    expect(parseActivity()).toEqual(parseActivity());
  });

  it("leaves the existing SUMMARY snapshot normalization unchanged", () => {
    expect(normalizeIbkrFlexXml(xml)).toEqual({
      source: "ibkr_flex",
      coverage: {
        kind: "configured_query_accounts",
        accountRefs: ["REDACTED-ACCOUNT"],
      },
      sourceAsOf: { value: "2025-12-31", precision: "date" },
      accounts: [
        {
          sourceAccountRef: "REDACTED-ACCOUNT",
          baseCurrency: "USD",
          positions: [
            {
              sourceSecurityId: "265598",
              sourceSecurityIdKind: "conid",
              assetKind: "generic",
              quantity: "9",
              quantityUnit: "shares",
              currency: "USD",
              sourcePrice: "220",
              sourcePriceCurrency: "USD",
              sourceValue: "1980",
              sourceValueCurrency: "USD",
              sourceAsOf: "2025-12-31",
              symbol: "AAPL",
              name: undefined,
              exchange: undefined,
            },
          ],
          cash: [{ currency: "USD", amount: "922.3" }],
          brokerTotal: { amount: "2902.3", currency: "USD", asOf: "2025-12-31" },
        },
      ],
    });
  });
});
