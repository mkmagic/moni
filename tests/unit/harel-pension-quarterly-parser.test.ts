// Parser gate for src/lib/connectors/documents/harel/pension-quarterly.ts.
//
// The fixtures are redacted `Item[]` dumps of two real Harel quarterly reports
// (see scripts/dump-pdf-items.mts); only the member's name and ת.ז. were
// replaced, and the geometry is untouched. They cover deliberately different
// shapes:
//
//   2026-Q1  one page, an employer column, a self-employed (עצמאי) row with no
//            salary, and a negative investment result
//   2025-Q3  a deposits table spilling onto page 2 with the totals row printed
//            only there, no employer column at all, and a balance equation that
//            drifts ₪11 — well past a naive rounding bound, which is why the
//            gate in D9 is ±₪50 rather than ±3.5
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkHarelPensionReport,
  harelPensionQuarterlyParser,
} from "@/lib/connectors/documents/harel/pension-quarterly";
import type { Item } from "@/lib/connectors/documents/pdf-text";

function fixture(name: string): Item[] {
  return JSON.parse(
    readFileSync(join(process.cwd(), "tests/fixtures/long-term-savings", `${name}.json`), "utf8"),
  ) as Item[];
}

const q1 = fixture("harel-pension-2026-q1");
const q3 = fixture("harel-pension-2025-q3");

const driftOf = (report: ReturnType<typeof harelPensionQuarterlyParser.parse>, name: string) =>
  checkHarelPensionReport(report).checks.find((check) => check.name === name)?.drift;

describe("harelPensionQuarterlyParser.recognises", () => {
  it("accepts both real reports", () => {
    expect(harelPensionQuarterlyParser.recognises(q1)).toBe(true);
    expect(harelPensionQuarterlyParser.recognises(q3)).toBe(true);
  });

  it("rejects a document that is not this report", () => {
    expect(harelPensionQuarterlyParser.recognises([])).toBe(false);
    expect(
      harelPensionQuarterlyParser.recognises([
        { text: "דוח שנתי", x: 0, right: 10, y: 700, centre: 5, page: 1 },
      ]),
    ).toBe(false);
  });
});

describe("harelPensionQuarterlyParser.parse — 2026 Q1", () => {
  const report = harelPensionQuarterlyParser.parse(q1);

  it("reads the header", () => {
    expect(report).toMatchObject({
      documentType: "דוח רבעוני",
      fundName: "הראל פנסיה",
      reportDate: "2026-03-31",
      statedPeriodStart: "2026-01-01",
      statedPeriodEnd: "2026-03-31",
      quarter: 1,
      year: 2026,
    });
  });

  it("reads section ב, keeping the sign of a losing quarter", () => {
    expect(report.movements).toEqual({
      openingBalance: "72306",
      contributions: "7076",
      investmentResult: "-2954",
      managementFeesCharged: "0",
      disabilityInsuranceCost: "-131",
      deathInsuranceCost: "-53",
      closingBalance: "76243",
    });
  });

  it("reads section א, including the retirement age printed inside the label", () => {
    expect(report.expectedPayments).toEqual({
      retirementAge: 60,
      monthlyPensionAtRetirement: "1290",
      // Printed as a dash on this report — "not applicable", not zero.
      monthlySurvivorPension: null,
      monthlyOrphanPension: "0",
      monthlyDependentParentPension: "0",
      monthlyFullDisabilityPension: "7810",
      contributionWaiverOnDisability: "1566",
    });
  });

  it("reads section ג, separating the member's fees from the fund average", () => {
    expect(report.managementFees).toEqual({
      onDeposit: "0.00",
      onSavings: "0.0018",
      fundAverageOnDeposit: "1.47",
      fundAverageOnSavings: "0.13",
    });
  });

  it("reads section ד", () => {
    expect(report.investmentTracks).toEqual([
      { name: "עוקב מדד S&P 500", returnPercent: "-3.81", expectedAnnualCostPercent: "0.10" },
    ]);
  });

  it("reads section ה, including the salary-less self-employed row", () => {
    expect(report.deposits.rows).toHaveLength(4);
    expect(report.deposits.rows[0]).toEqual({
      employer: "מעסיק לדוגמה",
      depositDate: "2026-01-01",
      forMonth: "2025-12",
      salary: "10416",
      employeeContribution: "729",
      employerContribution: "781",
      severance: "625",
      total: "2135",
    });
    // An עצמאי contribution comes out of the member's own bank account, unlike
    // every other row — the distinction D3 turns on. It has no salary cell.
    expect(report.deposits.rows[3]).toEqual({
      employer: "עצמאי",
      depositDate: "2026-03-01",
      forMonth: "2026-03",
      salary: null,
      employeeContribution: "1685",
      employerContribution: "0",
      severance: "0",
      total: "1685",
    });
    expect(report.deposits.totals).toEqual({
      employeeContribution: "3526",
      employerContribution: "1972",
      severance: "1578",
      total: "7076",
    });
  });

  it("reconciles", () => {
    expect(checkHarelPensionReport(report).balanceDrift).toBe("1");
    expect(driftOf(report, "deposits_vs_movements")).toBe("0");
  });
});

describe("harelPensionQuarterlyParser.parse — 2025 Q3", () => {
  const report = harelPensionQuarterlyParser.parse(q3);

  it("states a year-to-date period, not a quarter (D6)", () => {
    expect(report).toMatchObject({
      reportDate: "2025-09-30",
      statedPeriodStart: "2025-01-01",
      statedPeriodEnd: "2025-09-30",
      quarter: 3,
      year: 2025,
    });
  });

  it("continues the deposits table onto page 2 and finds the totals row there", () => {
    expect(report.deposits.rows).toHaveLength(21);
    // First row of page 1 and last row of page 2 — the span the single-page
    // reading silently truncated.
    expect(report.deposits.rows[0]).toMatchObject({ depositDate: "2025-01-09", total: "98" });
    expect(report.deposits.rows[20]).toMatchObject({
      depositDate: "2025-09-09",
      forMonth: "2025-08",
      total: "2134",
    });
    expect(report.deposits.totals).toEqual({
      employeeContribution: "6615",
      employerContribution: "7087",
      severance: "5670",
      total: "19371",
    });
  });

  it("leaves the employer blank when the report omits that column", () => {
    expect(report.deposits.rows.every((row) => row.employer === "")).toBe(true);
  });

  it("agrees with section ב on the deposits total once both pages are read", () => {
    expect(driftOf(report, "deposits_vs_movements")).toBe("0");
  });

  it("records a balance drift larger than a naive rounding bound", () => {
    // 44659 + 19371 + 2830 - 1 - 292 - 229 = 66338, printed 66349. Seven
    // shekel-rounded terms bound the drift at ±3.5 in theory; this real
    // document exceeds that, which is the evidence behind D9's ±₪50.
    expect(checkHarelPensionReport(report).balanceDrift).toBe("11");
  });

  it("keeps every per-row and column check within shekel rounding", () => {
    for (const check of checkHarelPensionReport(report).checks) {
      if (check.name === "balance_equation") continue;
      expect(Number(check.drift), `${check.name}: ${check.detail}`).toBeLessThanOrEqual(4);
    }
  });
});
