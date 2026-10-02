import { describe, expect, expectTypeOf, it } from "vitest";

import {
  InvestmentNormalizationError,
  normalizeInvestmentActivityEvidence,
  normalizeOpenLotEvidence,
  type InvestmentActivityEvidence,
  type OpenLotEvidence,
} from "@/lib/investments";

describe("investment evidence normalization", () => {
  it("normalizes signed decimal strings without routing them through numbers", () => {
    const activity = normalizeInvestmentActivityEvidence({
      source: "ibkr_flex",
      sourceAccountRef: "U123",
      idempotencyKey: "U123:exec:42",
      sourceExecutionId: "42",
      sourceSecurityId: "265598",
      sourceSecurityIdKind: "conid",
      activityType: "sell",
      tradeDate: "2026-08-31",
      settlementDate: "2026-09-02",
      quantity: "-0001.2500",
      quantityUnit: "shares",
      price: "+123.4500",
      grossAmount: "-154.312500",
      feeAmount: "-0.3500",
      taxAmount: "0",
      netCashAmount: "153.9625",
      currency: "USD",
      rawType: "Trade",
      provenance: "broker_reported",
    });

    expect(activity).toMatchObject({
      quantity: "-1.25",
      price: "123.45",
      grossAmount: "-154.3125",
      feeAmount: "-0.35",
      taxAmount: "0",
      netCashAmount: "153.9625",
    });
    expectTypeOf(activity).toEqualTypeOf<InvestmentActivityEvidence>();
  });

  it("normalizes opening-lot quantities and costs as decimal strings", () => {
    const lot = normalizeOpenLotEvidence({
      source: "opening_lot_import",
      sourceAccountRef: "account-1",
      idempotencyKey: "opening:account-1:lot-1",
      sourceLotId: "lot-1",
      sourceSecurityId: "US0378331005",
      sourceSecurityIdKind: "isin",
      tradeDate: "2020-01-02",
      originalQuantity: "10.5000",
      remainingQuantity: "4.2500",
      quantityUnit: "shares",
      unitCost: "123.4500",
      totalCost: "1296.225000",
      fees: "-0.50",
      currency: "USD",
      provenance: "imported",
    });

    expect(lot).toMatchObject({
      originalQuantity: "10.5",
      remainingQuantity: "4.25",
      unitCost: "123.45",
      totalCost: "1296.225",
      fees: "-0.5",
    });
    expectTypeOf(lot).toEqualTypeOf<OpenLotEvidence>();
  });

  it("retains only explicitly supplied broker lot allocations as exact decimals", () => {
    const sale = normalizeInvestmentActivityEvidence({
      source: "ibkr_flex",
      sourceAccountRef: "U123",
      idempotencyKey: "U123:exec:sale-1",
      activityType: "sell",
      tradeDate: "2026-08-31",
      quantity: "-2.5000",
      quantityUnit: "shares",
      currency: "USD",
      rawType: "Trade",
      brokerOpenDateTime: "20260101;120000",
      brokerLotAllocations: [{ sourceLotId: "broker-lot-7", quantity: "2.5000" }],
      provenance: "broker_reported",
    });

    expect(sale.brokerLotAllocations).toEqual([{ sourceLotId: "broker-lot-7", quantity: "2.5" }]);
    expect(
      normalizeInvestmentActivityEvidence({
        ...sale,
        idempotencyKey: "U123:exec:sale-2",
        brokerLotAllocations: undefined,
      }).brokerLotAllocations,
    ).toBeUndefined();
  });

  it("requires a durable source security id rather than a symbol or name", () => {
    expect(() =>
      normalizeOpenLotEvidence({
        source: "snaptrade",
        sourceAccountRef: "account-1",
        idempotencyKey: "lot-1",
        symbol: "AAPL",
        name: "Apple Inc.",
        tradeDate: "2020-01-02",
        originalQuantity: "1",
        remainingQuantity: "1",
        quantityUnit: "shares",
        totalCost: "100",
        currency: "USD",
        provenance: "broker_reported",
      }),
    ).toThrow(InvestmentNormalizationError);
  });

  it("rejects numeric money and mismatched identity or quantity pairs", () => {
    const base = {
      source: "ibkr_flex",
      sourceAccountRef: "U123",
      idempotencyKey: "exec-1",
      activityType: "buy",
      tradeDate: "2026-08-31",
      rawType: "Trade",
      provenance: "broker_reported",
    };

    expect(() => normalizeInvestmentActivityEvidence({ ...base, price: 1.25 })).toThrow(
      InvestmentNormalizationError,
    );
    expect(() =>
      normalizeInvestmentActivityEvidence({ ...base, sourceSecurityId: "265598" }),
    ).toThrow(InvestmentNormalizationError);
    expect(() => normalizeInvestmentActivityEvidence({ ...base, quantity: "1" })).toThrow(
      InvestmentNormalizationError,
    );
  });
});
