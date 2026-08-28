import { describe, expect, it } from "vitest";
import { parseAgamLiderimPortfolio, recognises } from "@/lib/connectors/agam-liderim";
import { DocumentParseError } from "@/lib/connectors/documents/types";
import { buildPortfolio, buildXlsx, HEADER_ROW, type AccountRow } from "./agam-liderim/workbook";

// Dummy account rows — all figures and identifiers invented, none real. Dates
// are Excel serials: 46234 → 2026-07-31 (the balances' as-of), 44927 →
// 2023-01-01 (a join date).
const PENSION: AccountRow = {
  productType: "קרן פנסיה מקיפה",
  provider: 'בית השקעות דמו בע"מ',
  infoDate: 46234,
  policyNumber: "111111111",
  productName: "פנסיית דמו",
  status: "פעיל",
  joinDate: 44927,
  balance: 100000,
};
const GEMEL: AccountRow = {
  productType: "קופת גמל",
  provider: 'מנורה דמו בע"מ',
  infoDate: 46234,
  policyNumber: "222222222",
  productName: "גמל דמו",
  status: "לא פעיל",
  joinDate: 44927,
  balance: 2500,
};
const HISHTALMUT: AccountRow = {
  productType: "קרן השתלמות",
  provider: 'קרן דמו לניהול קופות גמל בע"מ',
  infoDate: 46234,
  policyNumber: "333333333",
  productName: "השתלמות דמו",
  status: "פעיל",
  joinDate: 44927,
  balance: 15000,
};
// A pure death-risk policy: no accumulation, so not a savings account.
const RISK: AccountRow = {
  productType: "ריסק למקרה מוות",
  provider: 'ביטוח דמו בע"מ',
  infoDate: 46234,
  policyNumber: "444444444",
  productName: "-",
  status: "פעיל",
  joinDate: 44927,
  balance: "-",
};

describe("parseAgamLiderimPortfolio", () => {
  it("parses every account and excludes the totals and risk rows", () => {
    const bytes = buildPortfolio({
      rows: [PENSION, GEMEL, HISHTALMUT, RISK],
      totalsBalance: 117500,
    });
    const portfolio = parseAgamLiderimPortfolio(bytes);

    expect(portfolio.producedDate).toBe("2026-08-28");
    expect(portfolio.accounts).toHaveLength(3);
    expect(portfolio.accounts.map((a) => a.policyNumber)).toEqual([
      "111111111",
      "222222222",
      "333333333",
    ]);
    // The extracted balances reconcile with the file's printed grand total.
    const sum = portfolio.accounts.reduce((acc, a) => acc + Number(a.balance), 0);
    expect(sum).toBe(117500);

    const pension = portfolio.accounts[0];
    expect(pension).toMatchObject({
      policyNumber: "111111111",
      provider: 'בית השקעות דמו בע"מ',
      productName: "פנסיית דמו",
      product: "pension",
      status: "פעיל",
      balance: "100000",
      asOf: "2026-07-31",
      joinDate: "2023-01-01",
    });
  });

  it("reads however many account rows the file holds, not a fixed count", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      ...GEMEL,
      policyNumber: `9${i}00000`,
      balance: 1000 + i,
    }));
    const portfolio = parseAgamLiderimPortfolio(buildPortfolio({ rows: many, totalsBalance: 1 }));
    expect(portfolio.accounts).toHaveLength(9);
    expect(portfolio.accounts.at(-1)?.policyNumber).toBe("9800000");
  });

  it("maps every Hebrew product type, and falls back to a locked gemel", () => {
    const rows: AccountRow[] = [
      { ...PENSION, productType: "קרן פנסיה מקיפה", policyNumber: "1" },
      { ...HISHTALMUT, productType: "קרן השתלמות", policyNumber: "2" },
      { ...GEMEL, productType: "קופת גמל", policyNumber: "3" },
      { ...GEMEL, productType: "קופת גמל להשקעה", policyNumber: "4" },
      { ...PENSION, productType: "ביטוח מנהלים", policyNumber: "5" },
      { ...GEMEL, productType: "מוצר שאינו מוכר", policyNumber: "6" },
    ];
    const products = parseAgamLiderimPortfolio(buildPortfolio({ rows })).accounts.map(
      (a) => a.product,
    );
    expect(products).toEqual([
      "pension",
      "hishtalmut",
      "gemel",
      "gemel_investment",
      "managers_insurance",
      "gemel",
    ]);
  });

  it("takes the as-of from the data-validity column, not the produced banner", () => {
    // Produced 2026-08-28, but the balances are valid to 2026-07-31.
    const portfolio = parseAgamLiderimPortfolio(buildPortfolio({ rows: [PENSION] }));
    expect(portfolio.producedDate).toBe("2026-08-28");
    expect(portfolio.accounts[0].asOf).toBe("2026-07-31");
  });

  it("falls back to the produced date when a row has no data-validity date", () => {
    const portfolio = parseAgamLiderimPortfolio(
      buildPortfolio({ rows: [{ ...PENSION, infoDate: "-" }] }),
    );
    expect(portfolio.accounts[0].asOf).toBe("2026-08-28");
  });

  it("leaves an absent join date null rather than inventing one", () => {
    const portfolio = parseAgamLiderimPortfolio(
      buildPortfolio({ rows: [{ ...PENSION, joinDate: "-" }] }),
    );
    expect(portfolio.accounts[0].joinDate).toBeNull();
  });

  it("rejects a row missing a policy number rather than importing it unkeyed", () => {
    expect(() =>
      parseAgamLiderimPortfolio(buildPortfolio({ rows: [{ ...PENSION, policyNumber: "-" }] })),
    ).toThrow(DocumentParseError);
  });

  it("rejects a row whose balance is not a number", () => {
    expect(() =>
      parseAgamLiderimPortfolio(buildPortfolio({ rows: [{ ...PENSION, balance: "abc" }] })),
    ).toThrow(DocumentParseError);
  });

  it("ignores stray columns beyond the ones it reads", () => {
    // An unmapped projection column of numbers to the right of the balance must
    // not be mistaken for an account figure — the parser reads cells by their
    // header's column, so a value under no known header is never read.
    const bytes = buildXlsx([
      {
        name: "מוצרים ויתרות",
        rows: [
          [null, null, "הופק בתאריך: 28/08/2026"],
          [...HEADER_ROW, "חסכון צפוי"],
          [
            PENSION.productType,
            PENSION.provider,
            PENSION.infoDate,
            PENSION.policyNumber,
            PENSION.productName,
            PENSION.status,
            PENSION.joinDate,
            PENSION.balance,
            9999999, // stray, under the unmapped "חסכון צפוי" column
          ],
        ],
      },
    ]);
    const portfolio = parseAgamLiderimPortfolio(bytes);
    expect(portfolio.accounts).toHaveLength(1);
    expect(portfolio.accounts[0].balance).toBe("100000");
  });

  it("refuses a workbook without the balances sheet", () => {
    const bytes = buildPortfolio({ rows: [PENSION], sheetName: "גיליון אחר" });
    expect(recognises(bytes)).toBe(false);
    expect(() => parseAgamLiderimPortfolio(bytes)).toThrow(
      expect.objectContaining({ code: "unrecognised_document" }),
    );
  });

  it("refuses a balances sheet missing a column it depends on", () => {
    // Header present enough to be recognised (product-type label there), but the
    // balance column is renamed away.
    const header = HEADER_ROW.map((h) => (h === "צבירה כוללת" ? "משהו אחר" : h));
    const bytes = buildPortfolio({ header, rows: [PENSION] });
    expect(() => parseAgamLiderimPortfolio(bytes)).toThrow(
      expect.objectContaining({ code: "malformed_document" }),
    );
  });

  it("refuses a file that is not a workbook", () => {
    expect(() => parseAgamLiderimPortfolio(Buffer.from("not a zip"))).toThrow(
      expect.objectContaining({ code: "unreadable_document" }),
    );
  });

  it("recognises a genuine balances workbook", () => {
    expect(recognises(buildPortfolio({ rows: [PENSION] }))).toBe(true);
    expect(recognises(buildXlsx([{ name: "אחר", rows: [["x"]] }]))).toBe(false);
  });
});
