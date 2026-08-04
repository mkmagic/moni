import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  InvestmentNormalizationError,
  normalizeIbkrFlexXml,
  normalizeSchwabPositionsCsv,
  serializeCanonicalInvestmentEnvelope,
} from "@/lib/investments";

const fixture = (name: string) =>
  readFileSync(join(process.cwd(), "tests/fixtures/investments", name), "utf8");
const XML = fixture("ibkr-flex.xml");
const PROVIDER_XML = fixture("ibkr-flex-provider.xml");
const CSV = fixture("schwab-positions.csv");

describe("investment source normalization", () => {
  it("preserves high-precision source values as decimal text", () => {
    const ibkr = normalizeIbkrFlexXml(XML);
    expect(ibkr.accounts[0].positions[0].quantity).toBe("1.00000000000000000001");
    expect(ibkr.accounts[0].positions[0].sourceValue).toBe("123.00000000000000000124");
    const schwab = normalizeSchwabPositionsCsv(CSV, "USD");
    expect(schwab.accounts[0].sourceAccountRef).toBe("...SYN");
    expect(schwab.sourceAsOf).toEqual({
      value: "2026-07-31T16:15:00-04:00",
      precision: "timestamp",
    });
    expect(schwab.accounts[0].positions[0]).toMatchObject({
      assetKind: "etf",
      sourceSecurityIdKind: "schwab_symbol",
      quantity: "1000.00000000000000000001",
      sourceValue: "123000.00000000000000000124",
    });
    expect(schwab.accounts[0].cash).toEqual([{ currency: "USD", amount: "0.01" }]);
    expect(schwab.accounts[0].brokerTotal.amount).toBe("123000.01000000000000000124");
  });

  it("returns safe errors and canonical serialization", () => {
    expect(() => normalizeIbkrFlexXml("")).toThrow(InvestmentNormalizationError);
    const envelope = normalizeIbkrFlexXml(XML);
    expect(serializeCanonicalInvestmentEnvelope(envelope)).toBe(
      serializeCanonicalInvestmentEnvelope({ ...envelope }),
    );
  });

  it("aggregates compatible duplicate positions and cash", () => {
    const xml = XML.replace(
      "</OpenPositions>",
      `${XML.match(/<OpenPosition[^>]*\/>/)?.[0]}</OpenPositions>`,
    ).replace(
      "</CashReport>",
      '<CashReportCurrency accountId="SYN-ACCOUNT-1" currency="USD" endingCash="0.02"/></CashReport>',
    );
    const account = normalizeIbkrFlexXml(xml).accounts[0];
    expect(account.positions[0].quantity).toBe("2.00000000000000000002");
    expect(account.cash[0].amount).toBe("0.03");
  });

  it("reads POC-proven IBKR record tags without assuming provider wrapper names", () => {
    const providerVariant = XML.replace(
      /<EquitySummaryInBase>([\s\S]*?)<\/EquitySummaryInBase>/,
      "<NAVSummaryInBase>$1</NAVSummaryInBase>",
    );

    expect(normalizeIbkrFlexXml(providerVariant).accounts[0].brokerTotal.amount).toBe(
      "123.01000000000000000124",
    );
  });

  it("normalizes a Flex report in the provider's own default shape", () => {
    const envelope = normalizeIbkrFlexXml(PROVIDER_XML);
    const account = envelope.accounts[0];

    // yyyyMMdd is the Flex default; ISO-8601 output is only an optional query setting.
    expect(envelope.sourceAsOf).toEqual({ value: "2026-07-31", precision: "date" });
    // Lot rows restate the SUMMARY row rather than adding to it.
    expect(account.positions).toHaveLength(1);
    expect(account.positions[0]).toMatchObject({
      quantity: "10",
      assetKind: "etf",
      sourceAsOf: "2026-07-31",
    });
    // BASE_SUMMARY restates the per-currency rows converted to the base currency.
    expect(account.cash).toEqual([
      { currency: "USD", amount: "100" },
      { currency: "EUR", amount: "30" },
    ]);
    // A multi-day period reports NAV per date; the closing row is the snapshot.
    expect(account.brokerTotal).toEqual({
      amount: "2135",
      currency: "USD",
      asOf: "2026-07-31",
    });
  });

  it("rejects a NAV date that disagrees with itself", () => {
    expect(() =>
      normalizeIbkrFlexXml(
        PROVIDER_XML.replace(
          'reportDate="20260730" total="2100"',
          'reportDate="20260731" total="2100"',
        ),
      ),
    ).toThrow("identity_conflict");
  });

  it("rejects conflicting duplicates, omission, and nonzero implicit closure", () => {
    expect(() =>
      normalizeIbkrFlexXml(
        XML.replace('markPrice="123.00000000000000000001"', 'markPrice="124"').replace(
          "</OpenPositions>",
          `${XML.match(/<OpenPosition[^>]*\/>/)?.[0]}</OpenPositions>`,
        ),
      ),
    ).toThrow("identity_conflict");
    expect(() =>
      normalizeIbkrFlexXml(
        XML.replace(
          '<AccountInformation><AccountInformation accountId="SYN-ACCOUNT-1" currency="USD"/></AccountInformation>',
          "",
        ),
      ),
    ).toThrow("incomplete_coverage");
    expect(() =>
      normalizeIbkrFlexXml(
        XML.replace("123.01000000000000000124", "1")
          .replace(/<OpenPositions>[\s\S]*?<\/OpenPositions>/, "<OpenPositions/>")
          .replace(/<CashReport>[\s\S]*?<\/CashReport>/, "<CashReport/>"),
      ),
    ).toThrow("incomplete_snapshot");
  });

  it("accepts explicit zero state and enforces generated source row limits", () => {
    const zero = XML.replace(/<OpenPositions>[\s\S]*?<\/OpenPositions>/, "<OpenPositions/>")
      .replace(/<CashReport>[\s\S]*?<\/CashReport>/, "<CashReport/>")
      .replace("123.01000000000000000124", "0");
    expect(normalizeIbkrFlexXml(zero).accounts[0].brokerTotal.amount).toBe("0");
    const position = XML.match(/<OpenPosition[^>]*\/>/)?.[0] ?? "";
    expect(() =>
      normalizeIbkrFlexXml(
        XML.replace("</OpenPositions>", `${position.repeat(10_001)}</OpenPositions>`),
      ),
    ).toThrow("source_too_large");
    const cash = '<CashReportCurrency accountId="SYN-ACCOUNT-1" currency="USD" endingCash="0"/>';
    expect(() =>
      normalizeIbkrFlexXml(XML.replace("</CashReport>", `${cash.repeat(1_001)}</CashReport>`)),
    ).toThrow("source_too_large");
  });

  it("rejects malformed direct-export variants", () => {
    for (const malformed of [
      CSV.replace("Positions Total", "Missing Total"),
      CSV.replace("ETFs & Closed End Funds", "Unsupported Asset"),
      CSV.replace("$123,000.00000000000000000124", "$12x"),
      CSV.replace(
        "Positions for account Individual ...SYN as of 4:15 PM ET, 2026/07/31",
        "missing",
      ),
    ]) {
      expect(() => normalizeSchwabPositionsCsv(malformed, "USD")).toThrow(
        InvestmentNormalizationError,
      );
    }
  });
});
