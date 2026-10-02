// Parser gate for src/lib/connectors/documents/analyst/hishtalmut.ts.
//
// The fixture is a redacted `Item[]` dump of one real Analyst quarterly report
// (Q2 2026). Analyst emits Hebrew one GLYPH per text run, so the name and
// employer were redacted glyph by glyph (same letter count), and the geometry is
// untouched. Its deposits table is empty — the member made no deposits that
// period — so the table reader is exercised here on injected rows placed under
// the real header, which is synthetic and labelled as such below.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analystHishtalmutParser,
  normaliseAnalystHishtalmut,
} from "@/lib/connectors/documents/analyst/hishtalmut";
import { harelHishtalmutParser } from "@/lib/connectors/documents/harel/hishtalmut";
import { checkLongTermSavingsReport } from "@/lib/connectors/documents/long-term-savings-report";
import type { Item } from "@/lib/connectors/documents/pdf-text";

function fixture(name: string): Item[] {
  return JSON.parse(
    readFileSync(join(process.cwd(), "tests/fixtures/long-term-savings", `${name}.json`), "utf8"),
  ) as Item[];
}

const q2 = fixture("analyst-hishtalmut-2026-q2");
const parse = (items: Item[]) => analystHishtalmutParser.parse(items);
const malformed = expect.objectContaining({ code: "malformed_document" });

function replace(items: Item[], text: string, replacement: string): Item[] {
  let done = false;
  return items.map((item) => {
    if (done || item.text !== text) return item;
    done = true;
    return { ...item, text: replacement };
  });
}

/** The "no deposits this period" sentence, which arrives as single glyphs. */
const withoutEmptyTableSentence = (items: Item[]) =>
  items.filter((item) => !(Math.abs(item.y - 467.7) < 0.5 && item.x > 230 && item.right < 380));

/** A cell centred on `centre` (a column centre derived from the real header). */
function cell(text: string, centre: number, y: number): Item {
  return { text, x: centre - 10, right: centre + 10, centre, y, page: 1 };
}

/**
 * SYNTHETIC: one deposit row and a totals row under the real header. Centres
 * are the header's own: מועד 483.5, עבור חודש 421.5, משכורת 356.5,
 * תגמולי עובד 285.5, תגמולי מעסיק 214, סה"כ 139.5.
 */
function withDeposit(items: Item[], { totals = true } = {}): Item[] {
  const row = [
    cell("15/04/2026", 483.5, 460),
    cell("03/2026", 421.5, 460),
    cell("10,000", 356.5, 460),
    cell("250", 285.5, 460),
    cell("750", 214, 460),
    cell("1,000", 139.5, 460),
  ];
  const total = [
    cell('סה"כ', 483.5, 452),
    cell("250", 285.5, 452),
    cell("750", 214, 452),
    cell("1,000", 139.5, 452),
  ];
  return [...withoutEmptyTableSentence(items), ...row, ...(totals ? total : [])];
}

describe("analystHishtalmutParser.recognises", () => {
  it("accepts the real report, and no other parser's", () => {
    expect(analystHishtalmutParser.recognises(q2)).toBe(true);
    expect(analystHishtalmutParser.recognises([])).toBe(false);
    for (const other of ["harel-hishtalmut-2026-q1", "migdal-pension-2026-q2"])
      expect(analystHishtalmutParser.recognises(fixture(other))).toBe(false);
    expect(harelHishtalmutParser.recognises(q2)).toBe(false);
  });
});

describe("header and section א", () => {
  it("reads the period's two-digit years, the quarter, the fund and the withdrawal date", () => {
    expect(parse(q2)).toMatchObject({
      fundName: "אנליסט קרן השתלמות",
      reportDate: "2026-06-30",
      statedPeriodStart: "2026-01-01",
      statedPeriodEnd: "2026-06-30",
      quarter: 2,
      year: 2026,
      liquidFrom: "2028-05-29",
    });
  });

  it("refuses a report with no withdrawal date rather than losing it silently", () => {
    expect(() => parse(replace(q2, "29/05/2028", "·"))).toThrow(malformed);
  });
});

describe("sections ב, ג and ד", () => {
  it("reads all five movement lines and closes the balance equation exactly", () => {
    const report = normaliseAnalystHishtalmut(parse(q2));
    expect(report.movements).toEqual({
      openingBalance: "68121",
      contributions: "0",
      investmentResult: "6532",
      managementFeesCharged: "-216",
      closingBalance: "74437",
      disabilityInsuranceCost: null,
      deathInsuranceCost: null,
      transfersIn: null,
      actuarialAdjustment: null,
    });
    expect(checkLongTermSavingsReport(report).balanceDrift).toBe("0");
  });

  it("refuses a report missing a movement line", () => {
    expect(() => parse(replace(q2, "6,532", "·"))).toThrow(malformed);
  });

  it("reads the savings rate and fund average with their percent signs attached", () => {
    expect(parse(q2).fees).toEqual({ onSavings: "0.6", fundAverageOnSavings: "0.63" });
  });

  it("reads a negative return rather than dropping the track", () => {
    expect(parse(replace(q2, "9.60%", "-9.60%")).tracks).toEqual([
      { name: "אנליסט השתלמות מניות", returnPercent: "-9.60" },
    ]);
  });

  it("reads the track and its return", () => {
    expect(parse(q2).tracks).toEqual([{ name: "אנליסט השתלמות מניות", returnPercent: "9.60" }]);
  });
});

describe("section ה — deposits", () => {
  it("accepts an empty table when the report says there were no deposits", () => {
    expect(parse(q2).deposits).toEqual({ rows: [], totals: null });
  });

  it("refuses an empty table the report does not explain", () => {
    expect(() => parse(withoutEmptyTableSentence(q2))).toThrow(malformed);
  });

  it("reads a row and its totals under the real header (synthetic rows)", () => {
    expect(parse(withDeposit(q2)).deposits).toEqual({
      rows: [
        {
          depositDate: "2026-04-15",
          forMonth: "2026-03",
          salary: "10000",
          employeeContribution: "250",
          employerContribution: "750",
          total: "1000",
        },
      ],
      totals: { employeeContribution: "250", employerContribution: "750", total: "1000" },
    });
  });

  it("refuses rows with no totals row to reconcile them against (synthetic rows)", () => {
    expect(() => parse(withDeposit(q2, { totals: false }))).toThrow(malformed);
  });
});
