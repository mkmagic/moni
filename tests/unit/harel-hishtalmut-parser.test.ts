// Parser gate for src/lib/connectors/documents/harel/hishtalmut.ts.
//
// The fixtures are redacted `Item[]` dumps of three real Harel קרן השתלמות
// reports (see scripts/dump-pdf-items.mts); only the member's name, ת.ז. and
// account number were replaced, and the geometry is untouched. They cover
// deliberately different shapes:
//
//   2026-Q1   one page, three deposit rows, the whole table above the fold
//   2025-Q3   fifteen rows, a "deposited after the reporting period" block
//             printed BELOW the totals row, and a second page of footnotes
//   2025 annual  no period line and no quarter line at all, a deposits table
//             spilling onto page 2 with the totals printed only there, an extra
//             fee rate in section ג, and a section ד with the cost column
//             dropped and its footnote block moved alongside the track row
//
// All three balance EXACTLY — a קרן השתלמות has no insurance cost, so section
// ב's equation has four terms rather than the pension report's six.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  harelHishtalmutParser,
  normaliseHarelHishtalmut,
} from "@/lib/connectors/documents/harel/hishtalmut";
import { harelPensionQuarterlyParser } from "@/lib/connectors/documents/harel/pension-quarterly";
import { checkLongTermSavingsReport } from "@/lib/connectors/documents/long-term-savings-report";
import type { Item } from "@/lib/connectors/documents/pdf-text";

function fixture(name: string): Item[] {
  return JSON.parse(
    readFileSync(join(process.cwd(), "tests/fixtures/long-term-savings", `${name}.json`), "utf8"),
  ) as Item[];
}

const q3 = fixture("harel-hishtalmut-2025-q3");
const q1 = fixture("harel-hishtalmut-2026-q1");
const annual = fixture("harel-hishtalmut-2025-annual");

const parse = (items: Item[]) => harelHishtalmutParser.parse(items);
const malformed = expect.objectContaining({ code: "malformed_document" });

/** Replaces the first item whose text matches, leaving position untouched. */
function blank(items: Item[], text: string, page?: number): Item[] {
  let done = false;
  return items.map((item) => {
    if (done || item.text !== text || (page !== undefined && item.page !== page)) return item;
    done = true;
    return { ...item, text: "·" };
  });
}

describe("harelHishtalmutParser.recognises", () => {
  it("accepts all three real reports, quarterly and annual alike", () => {
    expect(harelHishtalmutParser.recognises(q3)).toBe(true);
    expect(harelHishtalmutParser.recognises(q1)).toBe(true);
    expect(harelHishtalmutParser.recognises(annual)).toBe(true);
  });

  it("rejects a document that is not this report", () => {
    expect(harelHishtalmutParser.recognises([])).toBe(false);
    expect(
      harelHishtalmutParser.recognises([
        { text: "דוח שנתי בקרן השתלמות", x: 0, right: 10, y: 700, centre: 5, page: 1 },
      ]),
    ).toBe(false);
  });

  // The two Harel parsers must not accept each other's documents: recognition
  // is the only thing standing between a user who picked the wrong connection
  // and a plausible-looking misparse.
  it("does not accept the pension report, and the pension parser does not accept these", () => {
    expect(harelHishtalmutParser.recognises(fixture("harel-pension-2025-q3"))).toBe(false);
    expect(harelPensionQuarterlyParser.recognises(q3)).toBe(false);
    expect(harelPensionQuarterlyParser.recognises(annual)).toBe(false);
  });
});

describe("header", () => {
  it("reads the quarterly report's printed period and quarter", () => {
    expect(parse(q3)).toMatchObject({
      documentType: "דוח רבעוני",
      fundName: "קרן החיסכון לצבא הקבע קרן השתלמות",
      reportDate: "2025-09-30",
      statedPeriodStart: "2025-01-01",
      statedPeriodEnd: "2025-09-30",
      quarter: 3,
      year: 2025,
    });
  });

  // The annual report prints neither "מתאריך … עד תאריך" nor a quarter line.
  // Its span comes from section ב's own heading ("תנועות בחשבונך בשנת 2025")
  // rather than from the title, so the stored period stays tied to the figures
  // it describes.
  it("derives the annual report's period from the movements heading", () => {
    expect(parse(annual)).toMatchObject({
      documentType: "דוח שנתי",
      reportDate: "2025-12-31",
      statedPeriodStart: "2025-01-01",
      statedPeriodEnd: "2025-12-31",
      quarter: null,
      year: 2025,
    });
  });

  it("reads the withdrawal date from section א", () => {
    expect(parse(q3).liquidFrom).toBe("2030-03-31");
    expect(parse(annual).liquidFrom).toBe("2030-03-31");
  });

  it("refuses a report with no period and no movements year", () => {
    expect(() => parse(blank(annual, "ב. תנועות בחשבונך בשנת 2025"))).toThrow(malformed);
  });

  it("refuses a report with no withdrawal date rather than losing it silently", () => {
    const damaged = annual.map((item) =>
      item.text.startsWith("יתרת הכספים המיועדים למשיכה")
        ? { ...item, text: "יתרת הכספים המיועדים למשיכה חד פעמית" }
        : item,
    );
    expect(() => parse(damaged)).toThrow(malformed);
  });
});

describe("section ב — movements", () => {
  it("reads all five lines and closes the balance equation exactly", () => {
    expect(parse(q3).movements).toEqual({
      openingBalance: "105",
      contributions: "5613",
      investmentResult: "395",
      managementFeesCharged: "-4",
      closingBalance: "6109",
    });
    expect(checkLongTermSavingsReport(normaliseHarelHishtalmut(parse(q3))).balanceDrift).toBe("0");
    expect(checkLongTermSavingsReport(normaliseHarelHishtalmut(parse(q1))).balanceDrift).toBe("0");
    expect(checkLongTermSavingsReport(normaliseHarelHishtalmut(parse(annual))).balanceDrift).toBe(
      "0",
    );
  });

  // Every line is required. A silently absent one would take the balance
  // equation down with it — and that equation is the only gate on the figure
  // that reaches a screen.
  it.each([
    "יתרת הכספים בחשבון בתחילת השנה",
    "כספים שהופקדו לחשבון",
    "רווחים בניכוי הוצאות ניהול השקעות",
    "דמי ניהול שנגבו בשנה זו",
    "יתרת הכספים בחשבון בסוף",
  ])("refuses the document when %s is unreadable", (label) => {
    expect(() => parse(blank(q3, label))).toThrow(malformed);
  });
});

describe("section ג — fees", () => {
  it("reads the member's rate and the fund average, and leaves the deposit fee null", () => {
    // A קרן השתלמות has no deposit fee; the fund-average box prints its label
    // and figure as one text run, so it is read out of the text rather than as
    // a value cell.
    expect(parse(q3).fees).toEqual({
      onSavings: "0.18",
      investmentExpenses: null,
      fundAverageOnSavings: "0.20",
    });
  });

  it("reads the investment-expense rate the annual report adds", () => {
    expect(parse(annual).fees.investmentExpenses).toBe("0.22");
  });
});

describe("section ד — investment tracks", () => {
  it("reads the return and the expected annual cost from the quarterly report", () => {
    expect(parse(q3).tracks).toEqual([
      { name: "מסלול כללי", returnPercent: "10.15", expectedAnnualCostPercent: "0.49" },
    ]);
  });

  // On the annual report the cost column is gone and the footnote block sits to
  // the LEFT of the track, sharing its baseline. Naming the track from the whole
  // row would call it "מסלול כללי * תשואות שהושגו במהלך שנת".
  it("names the track from the text right of its figures, not the whole row", () => {
    expect(parse(annual).tracks).toEqual([
      { name: "מסלול כללי", returnPercent: "14.26", expectedAnnualCostPercent: null },
    ]);
  });
});

describe("section ה — deposits", () => {
  it("reads every row and the printed totals", () => {
    const deposits = parse(q3).deposits;
    expect(deposits.rows).toHaveLength(15);
    expect(deposits.rows[0]).toEqual({
      depositDate: "2025-01-09",
      forMonth: "2024-12",
      salary: "9502",
      employeeContribution: "3",
      employerContribution: "8",
      total: "10",
    });
    expect(deposits.totals).toEqual({
      employeeContribution: "1403",
      employerContribution: "4210",
      total: "5613",
    });
  });

  it("continues a table across pages and takes the totals from the last one", () => {
    const deposits = parse(annual).deposits;
    // Eighteen rows on page 1, three more on page 2 — reading page 1 alone
    // would truncate the table and lose the totals row entirely.
    expect(deposits.rows).toHaveLength(21);
    expect(deposits.rows.at(-1)).toMatchObject({ depositDate: "2025-12-04", forMonth: "2025-11" });
    expect(deposits.totals).toEqual({
      employeeContribution: "2416",
      employerContribution: "7249",
      total: "9665",
    });
  });

  // Both reports print a "deposited after the reporting period" block below the
  // totals row. Those deposits belong to the NEXT report — the 2026-Q1 fixture
  // prints the annual report's trailing 01/01/2026 row as an ordinary one — and
  // the totals row deliberately excludes them.
  it("stops at the totals row, excluding the post-period block below it", () => {
    expect(parse(q3).deposits.rows.map((row) => row.depositDate)).not.toContain("2025-09-09");
    expect(parse(annual).deposits.rows.map((row) => row.depositDate)).not.toContain("2026-01-01");
    expect(parse(q1).deposits.rows[0]).toMatchObject({ depositDate: "2026-01-01" });
  });

  it("keeps the rows reconciled against the totals the document prints", () => {
    for (const items of [q3, q1, annual]) {
      const { checks } = checkLongTermSavingsReport(normaliseHarelHishtalmut(parse(items)));
      for (const check of checks.filter((c) => c.name.startsWith("column_total:")))
        // Shekel rounding only; nothing near the ±₪50 gate.
        expect(Number(check.drift)).toBeLessThanOrEqual(2);
    }
  });
});

describe("refuses a misread rather than storing one", () => {
  it("rejects the document rather than storing a missing deposit cell as ₪0", () => {
    // Blank the "עובד/ת" fragment, so the employee-contribution column's title
    // no longer matches and the matcher cannot place its cells. A fabricated
    // zero here would be persisted as fact and pass every check that could
    // have caught it.
    expect(() => parse(blank(q3, "עובד/ת"))).toThrow(malformed);
  });

  it("ignores a stray number that has drifted past its column's reach", () => {
    // Placed in the gutter between תגמולי עובד/ת (centre 303.15) and תגמולי
    // מעסיק (226.8): nearest to the employee column, but 37pt out when that
    // column reaches only 32.8. Inserted BEFORE the real cell in the array, so
    // an unbounded `row.find` would take it — with the bound removed this test
    // reads 999 as the employee contribution instead of 3.
    const target = q3.findIndex((item) => item.text === "3" && item.y > 284 && item.y < 286);
    expect(target).toBeGreaterThan(-1);
    const stray: Item = { text: "999", x: 252, right: 282, y: q3[target].y, centre: 267, page: 1 };
    const damaged = [...q3.slice(0, target), stray, ...q3.slice(target)];
    expect(parse(damaged).deposits.rows[0].employeeContribution).toBe("3");
  });

  it("fails the document when a continuation page has no column header", () => {
    // Page 2 of the annual report repeats the section heading and the header.
    // Dropping the header silently would lose three rows AND the totals row,
    // and the only check that could notice needs those totals.
    expect(() => parse(blank(annual, "מועד", 2))).toThrow(malformed);
  });

  it("rejects a date the calendar does not have", () => {
    // Shape alone would let "31/13/2025" through to a Postgres `date` column,
    // turning a misread into a promotion failure instead of a parse failure.
    const damaged = q3.map((item) =>
      item.text === "09/01/2025" ? { ...item, text: "31/13/2025" } : item,
    );
    expect(() => parse(damaged)).toThrow(malformed);
  });

  it("refuses a deposits table that has grown a severance column", () => {
    // Promotion writes ₪0 for severance on this product because the concept
    // does not exist here, and `column_total:severance` cannot notice the
    // column arriving — with nothing printed to compare against it checks 0
    // against 0. So the refusal has to be structural, at the header.
    const anchor = q3.find((item) => item.text === "מעסיק");
    expect(anchor).toBeDefined();
    // Placed to the LEFT of סה"כ rather than in the gutter a real severance
    // column would occupy. Anywhere among the money columns it also steals
    // cells from its neighbours, so the document would be refused for a
    // missing total whether or not the guard exists — and the test would pass
    // while proving nothing. Out here it captures no cells, so the refusal can
    // only come from the guard.
    const damaged = [
      ...q3,
      { text: "פיצויים", x: 95, right: 125, y: anchor!.y, centre: 110, page: 1 },
    ];
    expect(() => parse(damaged)).toThrow(malformed);
  });
});

describe("normaliseHarelHishtalmut", () => {
  it("marks what this product does not have as absent, not as zero", () => {
    const report = normaliseHarelHishtalmut(parse(q3));
    expect(report.movements.disabilityInsuranceCost).toBeNull();
    expect(report.movements.deathInsuranceCost).toBeNull();
    expect(report.projections).toBeNull();
    expect(report.fees.rateDeposit).toBeNull();
    expect(report.deposits.rows.every((row) => row.severance === null)).toBe(true);
    expect(report.deposits.rows.every((row) => row.employer === null)).toBe(true);
    expect(report.deposits.totals?.severance).toBeNull();
  });

  it("carries the withdrawal date through for the account's liquidity", () => {
    expect(normaliseHarelHishtalmut(parse(q1)).liquidFrom).toBe("2030-03-31");
  });
});
