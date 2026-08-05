/**
 * Parser for Harel's quarterly new-pension-fund report
 * ("דוח רבעוני בקרן הפנסיה החדשה הראל פנסיה").
 *
 * These PDFs carry a real text layer (ComposeDoc 6.0), so there is no OCR and
 * no model in the loop — only positioned text plus geometry. Hebrew arrives in
 * logical order and numbers are plain ASCII, so no bidi fixups are needed.
 *
 * Two things stay local to this file rather than moving into `pdf-text.ts`:
 * the section anchors (Harel's wording) and the deposits table's column
 * derivation. The latter solved *this* table — stacked header fragments merged
 * by x-overlap, cells assigned to the nearest header centre. Whether another
 * provider stacks headers, right-aligns, or rules its cells is unknown, so it
 * earns a shared home only once a second table proves the shape.
 *
 * Money is a decimal string end to end. The member's name and ת.ז. are
 * deliberately NOT extracted: nothing downstream stores them, and a field that
 * is never parsed cannot later be persisted by accident.
 */
import Decimal from "decimal.js";
import { z } from "zod";
import {
  SAME_ROW,
  groupRows,
  hasPercentSign,
  isNumber,
  joinRtl,
  numberLeftOf,
  toDecimalString,
  type Item,
} from "../pdf-text";
import { DocumentParseError, type DocumentParser } from "../types";

// ------------------------------------------------------------------- shape

const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/);
const isoDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const isoMonthString = z.string().regex(/^\d{4}-\d{2}$/);

/**
 * Section א. Computed by the fund from the CURRENT balance assuming no future
 * contributions — not a forecast of the member's pension, and misleading by an
 * order of magnitude if shown as one. Parsed and stored; not displayed (D8).
 */
const expectedPaymentsSchema = z.object({
  retirementAge: z.number().int().nullable(),
  monthlyPensionAtRetirement: decimalString.nullable(),
  monthlySurvivorPension: decimalString.nullable(),
  monthlyOrphanPension: decimalString.nullable(),
  monthlyDependentParentPension: decimalString.nullable(),
  monthlyFullDisabilityPension: decimalString.nullable(),
  contributionWaiverOnDisability: decimalString.nullable(),
});

/**
 * Section ב. Israeli quarterly reports state these year-to-date, not per
 * quarter — a Q3 report's contributions figure covers January–September. Stored
 * verbatim for the period the document itself asserts (D6).
 */
const movementsSchema = z.object({
  openingBalance: decimalString,
  contributions: decimalString,
  /** Signed: "רווחים" in a good quarter, "הפסדים" in a bad one. */
  investmentResult: decimalString,
  managementFeesCharged: decimalString,
  disabilityInsuranceCost: decimalString,
  deathInsuranceCost: decimalString,
  closingBalance: decimalString,
});

const managementFeesSchema = z.object({
  onDeposit: decimalString.nullable(),
  onSavings: decimalString.nullable(),
  fundAverageOnDeposit: decimalString.nullable(),
  fundAverageOnSavings: decimalString.nullable(),
});

const investmentTrackSchema = z.object({
  name: z.string().min(1),
  returnPercent: decimalString.nullable(),
  expectedAnnualCostPercent: decimalString.nullable(),
});

const depositRowSchema = z.object({
  /** Blank on reports that omit the employer column entirely. */
  employer: z.string(),
  depositDate: isoDateString,
  forMonth: isoMonthString,
  salary: decimalString.nullable(),
  employeeContribution: decimalString,
  employerContribution: decimalString,
  severance: decimalString,
  total: decimalString,
});

const depositTotalsSchema = z.object({
  employeeContribution: decimalString,
  employerContribution: decimalString,
  severance: decimalString,
  total: decimalString,
});

export const harelPensionQuarterlyReportSchema = z.object({
  documentType: z.string().min(1),
  fundName: z.string().min(1),
  /** `תאריך הדוח` — the snapshot's `as_of`. */
  reportDate: isoDateString,
  statedPeriodStart: isoDateString,
  statedPeriodEnd: isoDateString,
  quarter: z.number().int().min(1).max(4).nullable(),
  year: z.number().int().nullable(),
  expectedPayments: expectedPaymentsSchema,
  movements: movementsSchema,
  managementFees: managementFeesSchema,
  investmentTracks: z.array(investmentTrackSchema),
  deposits: z.object({
    rows: z.array(depositRowSchema),
    totals: depositTotalsSchema.nullable(),
  }),
});

export type HarelPensionQuarterlyReport = z.infer<typeof harelPensionQuarterlyReportSchema>;
export type HarelDepositRow = z.infer<typeof depositRowSchema>;

// ------------------------------------------------------------------ anchors

const DATE = String.raw`\d{2}\/\d{2}\/\d{4}`;
const DEPOSITS_SECTION = /^ה\. פירוט הפקדות/;
const DEPOSITS_HEADER_ANCHOR = "מועד";
const TOTALS_CELL = /^סה"כ$/;

/**
 * The titles the deposits table is expected to print. Geometry alone cannot say
 * which of the derived header groups are the table's: the "check your payslip"
 * advice box in the left margin has a line inside the header band, so it comes
 * back looking like an eighth column. Matching on the titles the parser already
 * depends on separates the two, and gives the table's own column pitch — which
 * is what bounds a cell's distance from its column, in place of any hardcoded
 * page coordinate.
 */
const COLUMN_TITLES = [
  /^מועד/,
  /^עבור חודש/,
  /^משכורת$/,
  /^תגמולי עובד/,
  /^תגמולי מעסיק$/,
  /^פיצויים$/,
  /^סה"כ/,
];

/**
 * `dd/mm/yyyy` → `yyyy-mm-dd`, rejecting a date the calendar does not have.
 * The schema below only checks the shape, so without this a misread "31/13/2026"
 * would travel all the way to a Postgres `date` column and surface as a
 * promotion failure rather than as the parse failure it is.
 */
function isoDate(ddmmyyyy: string): string {
  const [d, m, y] = ddmmyyyy.split("/");
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (
    date.getUTCFullYear() !== Number(y) ||
    date.getUTCMonth() !== Number(m) - 1 ||
    date.getUTCDate() !== Number(d)
  )
    throw new DocumentParseError("malformed_document");
  return `${y}-${m}-${d}`;
}

function isoMonth(mmyyyy: string): string {
  const [m, y] = mmyyyy.split("/");
  if (Number(m) < 1 || Number(m) > 12) throw new DocumentParseError("malformed_document");
  return `${y}-${m}`;
}

function findLabel(items: Item[], pattern: RegExp): Item | undefined {
  return items.find((item) => pattern.test(item.text));
}

/** The value cell of the RTL label/value pair whose label matches `pattern`. */
function valueAt(items: Item[], pattern: RegExp): string | null {
  const label = findLabel(items, pattern);
  return label ? numberLeftOf(items, label) : null;
}

/** A section-ב figure the document must carry; its absence means a misparse. */
function requiredValueAt(items: Item[], pattern: RegExp): string {
  const value = valueAt(items, pattern);
  if (value === null) throw new DocumentParseError("malformed_document");
  return value;
}

// ------------------------------------------------------------------- header

function parseHeader(items: Item[]): {
  documentType: string;
  fundName: string;
  reportDate: string;
  statedPeriodStart: string;
  statedPeriodEnd: string;
  quarter: number | null;
  year: number | null;
} {
  const text = items
    .filter((item) => item.page === 1)
    .map((item) => item.text)
    .join("\n");

  const reportDate = text.match(new RegExp(String.raw`תאריך הדוח:\s*(${DATE})`));
  const period = text.match(new RegExp(String.raw`מתאריך\s*(${DATE})\s*עד תאריך\s*(${DATE})`));
  if (!reportDate || !period) throw new DocumentParseError("malformed_document");

  const quarter = text.match(/לסוף הרבעון ה-(\d+) לשנת (\d{4})/);
  const title = text.match(/^(דוח \S+) בקרן הפנסיה החדשה (.+)$/m);
  if (!title) throw new DocumentParseError("malformed_document");

  return {
    documentType: title[1],
    fundName: title[2].trim(),
    reportDate: isoDate(reportDate[1]),
    statedPeriodStart: isoDate(period[1]),
    statedPeriodEnd: isoDate(period[2]),
    quarter: quarter ? Number(quarter[1]) : null,
    year: quarter ? Number(quarter[2]) : null,
  };
}

// -------------------------------------------------- sections א / ב / ג / ד

function parseExpectedPayments(items: Item[]): z.infer<typeof expectedPaymentsSchema> {
  const retirementLabel = findLabel(items, /^קצבה חודשית הצפויה לך בפרישה בגיל/);
  const age = retirementLabel?.text.match(/בגיל (\d+)/);
  return {
    retirementAge: age ? Number(age[1]) : null,
    monthlyPensionAtRetirement: retirementLabel ? numberLeftOf(items, retirementLabel) : null,
    monthlySurvivorPension: valueAt(items, /^קצבה חודשית לאלמן/),
    monthlyOrphanPension: valueAt(items, /^קצבה חודשית ליתום/),
    monthlyDependentParentPension: valueAt(items, /^קצבה חודשית להורה נתמך/),
    monthlyFullDisabilityPension: valueAt(items, /^קצבה חודשית במקרה של נכות/),
    contributionWaiverOnDisability: valueAt(items, /^שחרור מתשלום הפקדות/),
  };
}

function parseMovements(items: Item[]): z.infer<typeof movementsSchema> {
  return {
    openingBalance: requiredValueAt(items, /^יתרת הכספים בקרן בתחילת/),
    contributions: requiredValueAt(items, /^כספים שהופקדו לקרן/),
    investmentResult: requiredValueAt(items, /^(רווחים|הפסדים) בניכוי הוצאות ניהול השקעות/),
    managementFeesCharged: requiredValueAt(items, /^דמי ניהול שנגבו/),
    disabilityInsuranceCost: requiredValueAt(items, /^עלות ביטוח לסיכוני נכות/),
    deathInsuranceCost: requiredValueAt(items, /^עלות ביטוח למקרה מוות/),
    closingBalance: requiredValueAt(items, /^יתרת הכספים בקרן בסוף/),
  };
}

function parseManagementFees(items: Item[]): z.infer<typeof managementFeesSchema> {
  return {
    onDeposit: valueAt(items, /^דמי ניהול מהפקדה$/),
    onSavings: valueAt(items, /^דמי ניהול מחיסכון$/),
    // The left-hand "ממוצע דמי ניהול בקרן" box, labelled by the bare words alone.
    fundAverageOnDeposit: valueAt(items, /^מהפקדה$/),
    fundAverageOnSavings: valueAt(items, /^מחיסכון$/),
  };
}

/**
 * Section ד — one row per investment track: a name plus two percentages. The
 * rightmost is the return, the next one left the expected annual cost, matching
 * the printed column order.
 */
function parseInvestmentTracks(items: Item[]): z.infer<typeof investmentTrackSchema>[] {
  const heading = findLabel(items, /^ד\. מסלולי השקעה/);
  if (!heading) return [];
  const footnote = findLabel(items, /^\*תשואות שהושגו/);
  const top = heading.y - SAME_ROW;
  const bottom = footnote ? footnote.y + SAME_ROW : top - 200;

  const tracks: z.infer<typeof investmentTrackSchema>[] = [];
  const body = items.filter(
    (item) => item.page === heading.page && item.y < top && item.y > bottom,
  );
  for (const row of groupRows(body)) {
    const percents = row
      .filter((item) => isNumber(item) && hasPercentSign(row, item))
      .sort((a, b) => b.right - a.right);
    if (percents.length === 0) continue;
    const name = joinRtl(row.filter((item) => !isNumber(item) && item.text !== "%"));
    if (!name) continue;
    tracks.push({
      name,
      returnPercent: percents[0] ? toDecimalString(percents[0].text) : null,
      expectedAnnualCostPercent: percents[1] ? toDecimalString(percents[1].text) : null,
    });
  }
  return tracks;
}

// ------------------------------------------------------- section ה (table)

interface Column {
  title: string;
  centre: number;
}

/**
 * A row as read off the page, before validation. Every money cell may be null
 * here — that is how a cell the column matcher could not find travels to the
 * schema, which rejects the document rather than letting a fabricated zero
 * through. Only `salary` survives validation as nullable, because a
 * self-employed row genuinely has no salary cell.
 */
interface DepositRowCandidate extends Omit<
  HarelDepositRow,
  "employeeContribution" | "employerContribution" | "severance" | "total"
> {
  employeeContribution: string | null;
  employerContribution: string | null;
  severance: string | null;
  total: string | null;
}

type DepositTotalsCandidate = Record<keyof z.infer<typeof depositTotalsSchema>, string | null>;

/**
 * Merges the stacked header fragments into columns by x-overlap, so "תגמולי"
 * over "עובד/ת" becomes one column whose centre anchors the cells beneath it.
 * Derived per page — no coordinates are hardcoded, and a report that omits the
 * employer column still parses.
 */
function depositColumns(items: Item[], headerAnchor: Item): Column[] {
  const band = items.filter(
    (item) =>
      item.page === headerAnchor.page &&
      item.y <= headerAnchor.y + SAME_ROW &&
      item.y >= headerAnchor.y - 14,
  );

  const groups: Item[][] = [];
  for (const item of [...band].sort((a, b) => b.x - a.x)) {
    const overlapping = groups.find((group) =>
      group.some((other) => item.x < other.right && other.x < item.right),
    );
    if (overlapping) overlapping.push(item);
    else groups.push([item]);
  }

  return groups
    .map((group) => {
      const left = Math.min(...group.map((item) => item.x));
      const right = Math.max(...group.map((item) => item.right));
      return {
        title: [...group]
          .sort((a, b) => b.y - a.y)
          .map((item) => item.text)
          .join(" "),
        centre: (left + right) / 2,
      };
    })
    .sort((a, b) => b.centre - a.centre);
}

/** Reads one page's worth of the deposits table. */
function parseDepositsPage(
  items: Item[],
  anchor: Item,
): { rows: DepositRowCandidate[]; totals: DepositTotalsCandidate | null } {
  const columns = depositColumns(items, anchor);
  // Sorted right-to-left already, so adjacent pairs give the pitch directly.
  const named = columns.filter((column) => COLUMN_TITLES.some((title) => title.test(column.title)));
  if (named.length < 2) throw new DocumentParseError("malformed_document");
  /**
   * Half the tightest pitch between the table's own columns: the furthest a
   * cell can sit from a column's centre and still belong to it. Derived from
   * this page's header, so a wider table or an extra column re-derives it.
   */
  const maxDistance =
    Math.min(...named.slice(1).map((column, index) => named[index].centre - column.centre)) / 2;

  const cellIn = (row: Item[], title: RegExp): Item | undefined => {
    const column = columns.find((candidate) => title.test(candidate.title));
    if (!column) return undefined;
    return row.find((item) => {
      const nearest = columns.reduce((best, candidate) =>
        Math.abs(candidate.centre - item.centre) < Math.abs(best.centre - item.centre)
          ? candidate
          : best,
      );
      // Nearest is not sufficient on its own. Without a bound, any stray glyph
      // on the row — a footnote marker, half a split thousands group — snaps to
      // whichever column happens to be closest and is stored as that column's
      // figure. Nothing downstream would catch it: the balance equation is
      // section ב's arithmetic and says nothing about this table.
      return nearest === column && Math.abs(nearest.centre - item.centre) <= maxDistance;
    });
  };

  const body = items.filter(
    (item) =>
      item.page === anchor.page &&
      item.y < anchor.y - 14 &&
      // The left margin holds a "check your payslip" advice box whose lines
      // share baselines with the table's rows; the page footer sits below the
      // table. Bounded by the leftmost real column rather than by a page
      // coordinate, so a longer table stays inside it.
      item.centre >= named[named.length - 1].centre - maxDistance &&
      !/^עמוד \d+ מתוך/.test(item.text) &&
      !/^לתשומת לבך/.test(item.text),
  );

  const rows: DepositRowCandidate[] = [];
  for (const row of groupRows(body)) {
    const num = (pattern: RegExp): string | null => {
      const cell = cellIn(row, pattern);
      return cell && isNumber(cell) ? toDecimalString(cell.text) : null;
    };

    // The totals row closes the table — everything below it is footnotes.
    if (row.some((item) => TOTALS_CELL.test(item.text))) {
      return {
        rows,
        totals: {
          employeeContribution: num(/^תגמולי עובד/),
          employerContribution: num(/^תגמולי מעסיק$/),
          severance: num(/^פיצויים$/),
          total: num(/^סה"כ/),
        },
      };
    }

    const date = row.find((item) => new RegExp(`^${DATE}$`).test(item.text));
    const month = row.find((item) => /^\d{2}\/\d{4}$/.test(item.text));
    if (!date || !month) continue;

    rows.push({
      employer: joinRtl(row.filter((item) => !isNumber(item) && item !== date && item !== month)),
      depositDate: isoDate(date.text),
      forMonth: isoMonth(month.text),
      // Genuinely absent on a self-employed row, which has no salary cell.
      salary: num(/^משכורת$/),
      // Not defaulted to "0". A cell the column matcher fails to find is a
      // misread, and only the balance equation gates the import — a fabricated
      // zero here would be stored as fact and pass every check that could
      // catch it. Null instead, so the schema rejects the document loudly.
      employeeContribution: num(/^תגמולי עובד/),
      employerContribution: num(/^תגמולי מעסיק$/),
      severance: num(/^פיצויים$/),
      total: num(/^סה"כ/),
    });
  }
  return { rows, totals: null };
}

/**
 * Section ה, which continues across pages: Harel repeats the section heading
 * and the column header on each page it spills onto, and prints the totals row
 * only on the last. Columns are re-derived per page rather than carried over,
 * because each page's header is the authority for its own cells.
 */
function parseDeposits(items: Item[]): {
  rows: DepositRowCandidate[];
  totals: DepositTotalsCandidate | null;
} {
  const rows: DepositRowCandidate[] = [];
  let totals: DepositTotalsCandidate | null = null;

  for (const heading of items.filter((item) => DEPOSITS_SECTION.test(item.text))) {
    const anchor = items.find(
      (item) =>
        item.page === heading.page &&
        item.text === DEPOSITS_HEADER_ANCHOR &&
        item.y < heading.y &&
        heading.y - item.y < 30,
    );
    // Harel reprints the column header on every page the table spills onto, so
    // a page carrying the section heading without one means the layout moved.
    // Skipping it would drop that page's deposits silently, and the only check
    // that could notice needs the totals row — printed on the last page alone.
    if (!anchor) throw new DocumentParseError("malformed_document");
    const page = parseDepositsPage(items, anchor);
    rows.push(...page.rows);
    if (page.totals) totals = page.totals;
  }

  return { rows, totals };
}

// ------------------------------------------------------------------ parser

/**
 * Arithmetic the document asserts about itself. Every figure is rounded to the
 * nearest shekel, so exact equality is not available — the caller decides which
 * of these gate a write and with what tolerance (see D9); this function only
 * reports.
 */
export interface ReportCheck {
  name: string;
  drift: string;
  detail: string;
}

export function checkHarelPensionReport(report: HarelPensionQuarterlyReport): {
  balanceDrift: string;
  checks: ReportCheck[];
} {
  const d = (value: string | null) => new Decimal(value ?? "0");
  const m = report.movements;

  const expectedClosing = d(m.openingBalance)
    .plus(d(m.contributions))
    .plus(d(m.investmentResult))
    .plus(d(m.managementFeesCharged))
    .plus(d(m.disabilityInsuranceCost))
    .plus(d(m.deathInsuranceCost));
  const balanceDrift = expectedClosing.minus(d(m.closingBalance)).abs().toString();

  const checks: ReportCheck[] = [
    {
      name: "balance_equation",
      drift: balanceDrift,
      detail: `opening + movements = ${expectedClosing.toString()}, printed closing = ${m.closingBalance}`,
    },
  ];

  for (const row of report.deposits.rows) {
    const summed = d(row.employeeContribution)
      .plus(d(row.employerContribution))
      .plus(d(row.severance));
    checks.push({
      name: `deposit_row:${row.forMonth}:${row.depositDate}`,
      drift: summed.minus(d(row.total)).abs().toString(),
      detail: `${summed.toString()} vs printed total ${row.total}`,
    });
  }

  const totals = report.deposits.totals;
  if (totals) {
    for (const key of [
      "employeeContribution",
      "employerContribution",
      "severance",
      "total",
    ] as const) {
      const summed = report.deposits.rows.reduce(
        (acc, row) => acc.plus(d(row[key])),
        new Decimal(0),
      );
      checks.push({
        name: `column_total:${key}`,
        drift: summed.minus(d(totals[key])).abs().toString(),
        detail: `rows sum to ${summed.toString()}, printed total ${totals[key]}`,
      });
    }
    checks.push({
      name: "deposits_vs_movements",
      drift: d(totals.total).minus(d(m.contributions)).abs().toString(),
      detail: `table total ${totals.total} vs section ב contributions ${m.contributions}`,
    });
  }

  return { balanceDrift, checks };
}

export const harelPensionQuarterlyParser: DocumentParser<HarelPensionQuarterlyReport> = {
  id: "harel_pension_quarterly",
  version: 1,

  recognises(items) {
    const text = items.map((item) => item.text).join("\n");
    return (
      /דוח רבעוני/.test(text) &&
      /בקרן הפנסיה החדשה/.test(text) &&
      /הראל/.test(text) &&
      /^יתרת הכספים בקרן בסוף/m.test(text)
    );
  },

  parse(items) {
    const parsed = harelPensionQuarterlyReportSchema.safeParse({
      ...parseHeader(items),
      expectedPayments: parseExpectedPayments(items),
      movements: parseMovements(items),
      managementFees: parseManagementFees(items),
      investmentTracks: parseInvestmentTracks(items),
      deposits: parseDeposits(items),
    });
    if (!parsed.success) throw new DocumentParseError("malformed_document");
    return parsed.data;
  },
};
