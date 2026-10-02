// Parser gate for src/lib/connectors/documents/migdal/pension-quarterly.ts.
//
// The fixture is a redacted `Item[]` dump of one real Migdal quarterly report
// (Q2 2026); the member's name and ת.ז., the employer and the agent were
// replaced, and the geometry is untouched. Migdal emits one text run per word,
// so this also exercises `mergeRuns`. What makes the report its own shape:
//
//   - a fund's first year: the opening-balance cell is blank, and the balance
//     arrived as a transfer from another fund (section ב's "כספים שהעברת לקרן")
//   - an actuarial-balancing line, and no death-insurance line at all
//   - two "ריסק מצבירה" rows in section ה that the printed totals exclude
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { harelPensionQuarterlyParser } from "@/lib/connectors/documents/harel/pension-quarterly";
import { checkLongTermSavingsReport } from "@/lib/connectors/documents/long-term-savings-report";
import {
  migdalPensionQuarterlyParser,
  normaliseMigdalPension,
} from "@/lib/connectors/documents/migdal/pension-quarterly";
import type { Item } from "@/lib/connectors/documents/pdf-text";

function fixture(name: string): Item[] {
  return JSON.parse(
    readFileSync(join(process.cwd(), "tests/fixtures/long-term-savings", `${name}.json`), "utf8"),
  ) as Item[];
}

const q2 = fixture("migdal-pension-2026-q2");
const parse = (items: Item[]) => migdalPensionQuarterlyParser.parse(items);
const malformed = expect.objectContaining({ code: "malformed_document" });

/** Replaces the first item whose text matches, leaving position untouched. */
function replace(items: Item[], text: string, replacement: string): Item[] {
  let done = false;
  return items.map((item) => {
    if (done || item.text !== text) return item;
    done = true;
    return { ...item, text: replacement };
  });
}

describe("migdalPensionQuarterlyParser.recognises", () => {
  it("accepts the real report, and no other parser's", () => {
    expect(migdalPensionQuarterlyParser.recognises(q2)).toBe(true);
    expect(migdalPensionQuarterlyParser.recognises([])).toBe(false);
    for (const other of ["harel-pension-2026-q1", "harel-hishtalmut-2026-q1"])
      expect(migdalPensionQuarterlyParser.recognises(fixture(other))).toBe(false);
    expect(harelPensionQuarterlyParser.recognises(q2)).toBe(false);
  });
});

describe("header and section א", () => {
  it("reads the report date, period, quarter and fund", () => {
    const report = parse(q2);
    expect(report).toMatchObject({
      fundName: "מגדל מקפת אישית",
      reportDate: "2026-06-30",
      statedPeriodStart: "2026-01-01",
      statedPeriodEnd: "2026-06-30",
      quarter: 2,
      year: 2026,
    });
  });

  it("reads the projection, taking the amount left of the age rather than the age", () => {
    expect(parse(q2).expectedPayments).toEqual({
      retirementAge: 67,
      monthlyPensionAtRetirement: "3424",
      monthlySurvivorPension: null,
      monthlyOrphanPension: null,
      monthlyDependentParentPension: "1149",
      monthlyFullDisabilityPension: "4311",
      contributionWaiverOnDisability: "1000",
    });
  });
});

describe("section ב — movements", () => {
  it("reads the transfer-in and actuarial lines, and closes the balance within ₪1", () => {
    const report = normaliseMigdalPension(parse(q2));
    expect(report.movements).toEqual({
      // Blank on the page — the fund's first year.
      openingBalance: "0",
      contributions: "4311",
      investmentResult: "6395",
      transfersIn: "125911",
      managementFeesCharged: "-107",
      disabilityInsuranceCost: "-33",
      deathInsuranceCost: null,
      actuarialAdjustment: "-32",
      closingBalance: "136444",
    });
    expect(checkLongTermSavingsReport(report).balanceDrift).toBe("1");
  });

  it("lets the balance equation catch a transfer it failed to read", () => {
    const report = normaliseMigdalPension(parse(replace(q2, "125,911", "·")));
    expect(Number(checkLongTermSavingsReport(report).balanceDrift)).toBeGreaterThan(50);
  });

  it("refuses a report whose opening-balance line is missing, not merely blank", () => {
    expect(() => parse(q2.filter((item) => item.text !== "בתחילת"))).toThrow(malformed);
  });

  it("refuses a report missing a required line", () => {
    expect(() => parse(replace(q2, "136,444", "·"))).toThrow(malformed);
  });
});

describe("sections ג and ד", () => {
  it("reads the member's rates and the fund averages", () => {
    expect(parse(q2).managementFees).toEqual({
      onDeposit: "1.70",
      onSavings: "0.08",
      fundAverageOnDeposit: "1.54",
      fundAverageOnSavings: "0.14",
    });
  });

  it("reads each track's return, joining a name that wraps onto a second line", () => {
    expect(parse(q2).tracks).toEqual([
      { name: "מסלול מניות", returnPercent: "8.14" },
      { name: "מסלול לבני 50 ומטה - תלוי גיל", returnPercent: "7.02" },
    ]);
  });
});

describe("section ה — deposits", () => {
  it("reads the deposit rows and the printed totals, leaving out the ריסק מצבירה rows", () => {
    const { rows, totals } = parse(q2).deposits;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      employer: "חברה לדוגמה מש",
      depositDate: "2026-04-15",
      forMonth: "2026-02",
      salary: "8455",
      employeeContribution: "507",
      employerContribution: "550",
      severance: "507",
      total: "1564",
    });
    // A row with no salary cell is real, not a misread.
    expect(rows[1].salary).toBeNull();
    expect(totals).toEqual({
      employeeContribution: "1398",
      employerContribution: "1515",
      severance: "1398",
      total: "4311",
    });
  });

  it("reconciles every column against the printed totals and section ב", () => {
    const { checks } = checkLongTermSavingsReport(normaliseMigdalPension(parse(q2)));
    for (const check of checks.filter((c) => c.name !== "balance_equation"))
      expect(check.drift, check.name).toBe("0");
  });

  it("rejects the document rather than storing a missing deposit cell as ₪0", () => {
    expect(() => parse(replace(q2, "550", "·"))).toThrow(malformed);
  });

  it("refuses deposit rows with no totals row to reconcile them against", () => {
    const totalsRow = q2.find((item) => item.text === 'סה"כ' && item.y < 200)!;
    expect(() => parse(q2.filter((item) => Math.abs(item.y - totalsRow.y) > 1))).toThrow(malformed);
  });

  it("rejects a deposit date the calendar does not have", () => {
    expect(() => parse(replace(q2, "15/04/2026", "31/04/2026"))).toThrow(malformed);
  });

  it("fails the document when the table heading is there but its header is not", () => {
    expect(() => parse(q2.filter((item) => item.text !== "מועד"))).toThrow(malformed);
  });
});
