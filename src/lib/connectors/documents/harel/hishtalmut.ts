/**
 * Parser for Harel's קרן השתלמות reports — both the quarterly
 * ("דוח רבעוני בקרן השתלמות") and the annual ("דוח שנתי בקרן השתלמות").
 *
 * One parser covers both because they are the same document with sections
 * dropped, not two layouts: identical header, identical section lettering
 * א–ה, identical deposits table. What the annual report omits is the
 * `מתאריך … עד תאריך` period line, the quarter line, and the expected-annual-
 * cost column in section ד; what it adds is one extra fee rate. Each of those
 * is handled where it occurs and none of them changes how the page is read, so
 * splitting into two parsers would duplicate the whole file to vary four
 * lookups. `documentType` records which one it was.
 *
 * Against the pension parser in `pension-quarterly.ts`, the differences that
 * matter are all subtractions:
 *
 *   - No insurance. A קרן השתלמות carries no death or disability cover, so
 *     section ב has five lines instead of seven and its balance equation is
 *     opening + contributions + result + fees = closing. It balances EXACTLY on
 *     all three fixtures, which the pension's never does.
 *   - No פיצויים (severance) column and no employer column in section ה. The
 *     employer is stated once in the page header instead.
 *   - Section א is two lump sums rather than a table of monthly pensions.
 *
 * Money is a decimal string end to end. The member's name, ת.ז. and account
 * number are deliberately NOT extracted.
 */
import { z } from "zod";
import type { LongTermSavingsReport } from "../long-term-savings-report";
import {
  SAME_ROW,
  depositColumns,
  findLabel,
  groupRows,
  hasPercentSign,
  isNumber,
  joinRtl,
  toDecimalString,
  valueAt,
  type Column,
  type Item,
} from "../pdf-text";
import {
  DATE,
  DEPOSITS_SECTION,
  TOTALS_CELL,
  decimalString,
  isoDate,
  isoDateString,
  isoMonth,
  isoMonthString,
  parseDeposits,
  requiredValueAt,
} from "./shared";
import { DocumentParseError, type DocumentParser } from "../types";

// ------------------------------------------------------------------- shape

/**
 * Section ב. Israeli reports state these from the start of the fiscal year, not
 * per quarter — a Q3 report's contributions figure covers January–September
 * (D6). Stored verbatim for the period the document itself asserts.
 */
const movementsSchema = z.object({
  openingBalance: decimalString,
  contributions: decimalString,
  /** Signed: "רווחים" in a good period, "הפסדים" in a bad one. */
  investmentResult: decimalString,
  managementFeesCharged: decimalString,
  closingBalance: decimalString,
});

const feesSchema = z.object({
  /** The member's own rate on savings. A קרן השתלמות has no deposit fee. */
  onSavings: decimalString.nullable(),
  /** Printed only on the annual report. */
  investmentExpenses: decimalString.nullable(),
  /** The left-margin "ממוצע דמי ניהול בקופה" box. */
  fundAverageOnSavings: decimalString.nullable(),
});

const trackSchema = z.object({
  name: z.string().min(1),
  returnPercent: decimalString.nullable(),
  /** Absent from the annual report, which defers it to the extended report. */
  expectedAnnualCostPercent: decimalString.nullable(),
});

const depositRowSchema = z.object({
  depositDate: isoDateString,
  forMonth: isoMonthString,
  salary: decimalString.nullable(),
  employeeContribution: decimalString,
  employerContribution: decimalString,
  total: decimalString,
});

const depositTotalsSchema = z.object({
  employeeContribution: decimalString,
  employerContribution: decimalString,
  total: decimalString,
});

export const harelHishtalmutReportSchema = z.object({
  documentType: z.string().min(1),
  fundName: z.string().min(1),
  /** `תאריך הדוח` — the snapshot's `as_of`. */
  reportDate: isoDateString,
  statedPeriodStart: isoDateString,
  statedPeriodEnd: isoDateString,
  quarter: z.number().int().min(1).max(4).nullable(),
  year: z.number().int(),
  /**
   * Section א's `החל מ- …` — the date the fund becomes withdrawable. This is
   * the one field on a קרן השתלמות report the pension report has no analogue
   * for, and it is what fills `long_term_savings_details.liquid_from`.
   */
  liquidFrom: isoDateString,
  movements: movementsSchema,
  fees: feesSchema,
  tracks: z.array(trackSchema),
  deposits: z.object({
    rows: z.array(depositRowSchema),
    totals: depositTotalsSchema.nullable(),
  }),
});

export type HarelHishtalmutReport = z.infer<typeof harelHishtalmutReportSchema>;

// ------------------------------------------------------------------ anchors

/**
 * The titles the deposits table is expected to print. Geometry alone cannot say
 * which of the derived header groups are the table's: the "check your payslip"
 * advice box in the left margin has lines inside the header band, so it comes
 * back looking like an extra column. Matching on the titles the parser already
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
  /^סה"כ/,
];

/**
 * A column this parser has no field for. Not a hypothetical: the schema's
 * deposit row has a severance column because the pension report prints one, and
 * promotion writes ₪0 for a קרן השתלמות because the concept does not exist
 * here. That zero is only honest while the column is genuinely absent — and
 * `column_total:severance` cannot notice it arriving, because with no printed
 * severance total it compares 0 against 0 and passes. So the refusal has to be
 * structural, at the header, which is the one place the column's arrival is
 * visible.
 */
const UNSUPPORTED_COLUMN_TITLES = [/^פיצויים/];

// ------------------------------------------------------------------- header

function parseHeader(items: Item[]): {
  documentType: string;
  fundName: string;
  reportDate: string;
  statedPeriodStart: string;
  statedPeriodEnd: string;
  quarter: number | null;
  year: number;
  liquidFrom: string;
} {
  const text = items
    .filter((item) => item.page === 1)
    .map((item) => item.text)
    .join("\n");

  const reportDate = text.match(new RegExp(String.raw`תאריך הדוח:\s*(${DATE})`));
  // "לשנת" is the fiscal year the whole report is about, and it is the only
  // place the annual report states one at all.
  const title = text.match(/^(דוח \S+) בקרן השתלמות (.+?) לשנת (\d{4})$/m);
  if (!reportDate || !title) throw new DocumentParseError("malformed_document");

  /**
   * The quarterly report prints an explicit period; the annual report prints
   * none, and states its span only as "בשנת YYYY" in the section-ב heading.
   * Deriving the calendar year from that heading — rather than from the title,
   * which could name a year the movements section disagrees with — keeps the
   * stored period tied to the figures it describes. The end is the report date
   * itself, which is the last day the document speaks for.
   */
  const period = text.match(new RegExp(String.raw`מתאריך\s*(${DATE})\s*עד תאריך\s*(${DATE})`));
  const movementsYear = text.match(/^ב\. תנועות בחשבונך בשנת (\d{4})$/m);
  const span = period
    ? { start: isoDate(period[1]), end: isoDate(period[2]) }
    : movementsYear
      ? { start: `${movementsYear[1]}-01-01`, end: isoDate(reportDate[1]) }
      : null;
  if (!span) throw new DocumentParseError("malformed_document");

  // Section א states the date the money becomes withdrawable. Required: it is
  // what makes this account `liquid_after` rather than merely locked, and a
  // silently missing one would leave the liquidity date null forever, since the
  // PDF is discarded after parsing (D10).
  const liquidFrom = text.match(
    new RegExp(String.raw`יתרת הכספים המיועדים למשיכה חד פעמית החל מ-\s*(${DATE})`),
  );
  if (!liquidFrom) throw new DocumentParseError("malformed_document");

  const quarter = text.match(/לסוף הרבעון ה-(\d+) לשנת (\d{4})/);

  return {
    documentType: title[1],
    fundName: title[2].trim(),
    reportDate: isoDate(reportDate[1]),
    statedPeriodStart: span.start,
    statedPeriodEnd: span.end,
    quarter: quarter ? Number(quarter[1]) : null,
    year: Number(title[3]),
    liquidFrom: isoDate(liquidFrom[1]),
  };
}

// -------------------------------------------------------- sections ב / ג / ד

/**
 * Section ב. Five lines, not the pension report's seven — there is no insurance
 * cost to deduct. Every one is required: the equation these five satisfy is the
 * only gate on the balance that reaches a screen, so a line silently read as
 * absent would take its own gate down with it.
 */
function parseMovements(items: Item[]): z.infer<typeof movementsSchema> {
  return {
    openingBalance: requiredValueAt(items, /^יתרת הכספים בחשבון בתחילת/),
    contributions: requiredValueAt(items, /^כספים שהופקדו לחשבון$/),
    investmentResult: requiredValueAt(items, /^(רווחים|הפסדים) בניכוי הוצאות ניהול השקעות/),
    managementFeesCharged: requiredValueAt(items, /^דמי ניהול שנגבו/),
    closingBalance: requiredValueAt(items, /^יתרת הכספים בחשבון בסוף/),
  };
}

/**
 * Section ג. The member's own rates sit in a normal RTL label/value pair, but
 * the fund-average box in the left margin prints its label and figure as a
 * SINGLE text run ("מחיסכון 0.20%") with no separate number cell, so
 * `numberLeftOf` finds nothing there and it has to be read out of the text.
 */
function parseFees(items: Item[]): z.infer<typeof feesSchema> {
  const fundAverage = items
    .map((item) => item.text.match(/^מחיסכון\s+(\d+(?:\.\d+)?)%$/))
    .find((match) => match !== null);

  return {
    onSavings: valueAt(items, /^דמי ניהול מחיסכון$/),
    investmentExpenses: valueAt(items, /^הוצאות ניהול השקעות$/),
    fundAverageOnSavings: fundAverage ? fundAverage[1] : null,
  };
}

/**
 * Section ד — one row per investment track: a name plus one or two percentages.
 *
 * The name is taken as the text to the RIGHT of the row's rightmost figure,
 * which is the same RTL rule the rest of the file rests on: a row's figures sit
 * to the left of the label they belong to. Bounding it that way rather than by
 * "every non-numeric item on the row" is what the annual report forces — there
 * the footnote block moved from beneath the table to its left and shares the
 * track's baseline, so joining the whole row would name the track after a
 * footnote.
 *
 * Which percentage is which comes from the header, not from position. The
 * annual report drops the cost column entirely (it defers the figure to the
 * extended report), so "rightmost is the return, next is the cost" would
 * silently file a lone cost as a return on any future report that prints the
 * pair the other way round.
 */
function parseTracks(items: Item[]): z.infer<typeof trackSchema>[] {
  const heading = findLabel(items, /^ד\. מסלולי השקעה/);
  const next = findLabel(items, DEPOSITS_SECTION);
  if (!heading || !next) return [];

  // The cost column's header. The annual report has no such column but does
  // carry a footnote opening with the same words, disambiguated by its leading
  // asterisks.
  const costHeader = items.find(
    (item) =>
      item.page === heading.page &&
      item.y < heading.y + SAME_ROW &&
      item.y > next.y &&
      /^עלות שנתית/.test(item.text),
  );

  const body = items.filter(
    (item) => item.page === heading.page && item.y < heading.y - SAME_ROW && item.y > next.y,
  );

  const tracks: z.infer<typeof trackSchema>[] = [];
  for (const row of groupRows(body)) {
    const percents = row.filter((item) => isNumber(item) && hasPercentSign(row, item));
    if (percents.length === 0) continue;

    // Everything to the right of the rightmost figure, its "%" glyph included —
    // the glyph abuts the number on the right, so it is part of the figure's
    // extent rather than part of the name.
    const rightEdge = Math.max(
      ...row
        .filter((item) => item.text === "%" || percents.includes(item))
        .map((item) => item.right),
    );
    const name = joinRtl(row.filter((item) => item.x >= rightEdge));
    if (!name) continue;

    const cost = costHeader
      ? percents.reduce((best, item) =>
          Math.abs(item.centre - costHeader.centre) < Math.abs(best.centre - costHeader.centre)
            ? item
            : best,
        )
      : undefined;
    const rest = percents.filter((item) => item !== cost).sort((a, b) => b.right - a.right);

    tracks.push({
      name,
      returnPercent: rest[0] ? toDecimalString(rest[0].text) : null,
      expectedAnnualCostPercent: cost ? toDecimalString(cost.text) : null,
    });
  }
  return tracks;
}

// -------------------------------------------------------- section ה (table)

/**
 * A row as read off the page, before validation. Every money cell may be null
 * here — that is how a cell the column matcher could not find travels to the
 * schema, which rejects the document rather than letting a fabricated zero
 * through. Only `salary` survives validation as nullable, because a row for a
 * correction or a stray shekel genuinely has no salary behind it.
 */
interface DepositRowCandidate {
  depositDate: string;
  forMonth: string;
  salary: string | null;
  employeeContribution: string | null;
  employerContribution: string | null;
  total: string | null;
}

type DepositTotalsCandidate = Record<keyof z.infer<typeof depositTotalsSchema>, string | null>;

/** Reads one page's worth of the deposits table. */
function parseDepositsPage(
  items: Item[],
  anchor: Item,
): { rows: DepositRowCandidate[]; totals: DepositTotalsCandidate | null } {
  const columns = depositColumns(items, anchor);
  if (columns.some((column) => UNSUPPORTED_COLUMN_TITLES.some((title) => title.test(column.title))))
    throw new DocumentParseError("malformed_document");

  // Sorted right-to-left already, so adjacent pairs give the pitch directly.
  const named = columns.filter((column) => COLUMN_TITLES.some((title) => title.test(column.title)));
  if (named.length < 2) throw new DocumentParseError("malformed_document");

  /**
   * How far a cell may sit from a column's centre and still belong to it: half
   * the pitch to that column's OWN nearest neighbour, derived per column.
   *
   * The pension parser takes one bound for the whole table, half the tightest
   * pitch anywhere in it. That is safe when the columns are evenly spaced and
   * wrong here. This table's tightest pitch is between מועד and עבור חודש —
   * two wide date columns whose cells are near-perfectly centred, 57pt apart —
   * while the money columns run up to 79pt apart and print right-aligned
   * figures that drift well off centre when the figure is short. A single-digit
   * "0" in תגמולי עובד/ת sits 30pt from that column's centre, so the tightest-
   * pitch bound rejects it, the cell arrives null, and Zod refuses the whole
   * document. Per column, the same rule accepts it with room to spare and still
   * refuses anything that has strayed past the midpoint to the next column.
   */
  const reach = new Map<Column, number>(
    named.map((column, index) => [
      column,
      Math.min(
        ...[named[index - 1], named[index + 1]]
          .filter((neighbour) => neighbour !== undefined)
          .map((neighbour) => Math.abs(neighbour.centre - column.centre)),
      ) / 2,
    ]),
  );

  const cellIn = (row: Item[], title: RegExp): Item | undefined => {
    const column = columns.find((candidate) => title.test(candidate.title));
    const limit = column && reach.get(column);
    if (!column || limit === undefined) return undefined;
    return row.find((item) => {
      const nearest = columns.reduce((best, candidate) =>
        Math.abs(candidate.centre - item.centre) < Math.abs(best.centre - item.centre)
          ? candidate
          : best,
      );
      // Nearest is not sufficient on its own. Without a bound, any stray glyph
      // on the row — a footnote marker, half a split thousands group — snaps to
      // whichever column happens to be closest and is stored as that column's
      // figure.
      return nearest === column && Math.abs(nearest.centre - item.centre) <= limit;
    });
  };

  const leftmost = named[named.length - 1];
  const body = items.filter(
    (item) =>
      item.page === anchor.page &&
      item.y < anchor.y - 14 &&
      // The left margin holds a "check your payslip" advice box whose lines
      // share baselines with the table's rows; the page footer sits below the
      // table. Bounded by the leftmost real column rather than by a page
      // coordinate, so a longer table stays inside it.
      item.centre >= leftmost.centre - (reach.get(leftmost) ?? 0) &&
      !/^עמוד \d+ מתוך/.test(item.text),
  );

  const rows: DepositRowCandidate[] = [];
  for (const row of groupRows(body)) {
    const num = (pattern: RegExp): string | null => {
      const cell = cellIn(row, pattern);
      return cell && isNumber(cell) ? toDecimalString(cell.text) : null;
    };

    /**
     * The totals row closes the table. Everything below it is footnotes and, on
     * these reports, a "פירוט הפקדות … שהופקדו לאחר תקופת הדיווח" block: real
     * deposits for the report's year that landed after its period ended, which
     * the totals row deliberately excludes. Stopping here excludes them too,
     * which is both what makes the column totals reconcile and correct on its
     * own terms — the next period's report prints those same rows as ordinary
     * ones, and the 2026-Q1 fixture is exactly that continuation.
     */
    if (row.some((item) => TOTALS_CELL.test(item.text))) {
      return {
        rows,
        totals: {
          employeeContribution: num(/^תגמולי עובד/),
          employerContribution: num(/^תגמולי מעסיק$/),
          total: num(/^סה"כ/),
        },
      };
    }

    const date = row.find((item) => new RegExp(`^${DATE}$`).test(item.text));
    const month = row.find((item) => /^\d{2}\/\d{4}$/.test(item.text));
    if (!date || !month) continue;

    rows.push({
      depositDate: isoDate(date.text),
      forMonth: isoMonth(month.text),
      salary: num(/^משכורת$/),
      // Not defaulted to "0". A cell the column matcher fails to find is a
      // misread, and a fabricated zero here would be stored as fact and pass
      // every check that could catch it. Null instead, so the schema rejects
      // the document loudly.
      employeeContribution: num(/^תגמולי עובד/),
      employerContribution: num(/^תגמולי מעסיק$/),
      total: num(/^סה"כ/),
    });
  }
  return { rows, totals: null };
}

// ------------------------------------------------------------------ parser

/**
 * Maps the page-faithful shape onto what the domain layer stores.
 *
 * Every null introduced here is a concept the product does not have, not a cell
 * that failed to parse — those were already rejected by the Zod schema above.
 */
export function normaliseHarelHishtalmut(report: HarelHishtalmutReport): LongTermSavingsReport {
  return {
    fundName: report.fundName,
    reportDate: report.reportDate,
    statedPeriodStart: report.statedPeriodStart,
    statedPeriodEnd: report.statedPeriodEnd,
    quarter: report.quarter,
    year: report.year,
    liquidFrom: report.liquidFrom,
    movements: {
      openingBalance: report.movements.openingBalance,
      contributions: report.movements.contributions,
      investmentResult: report.movements.investmentResult,
      managementFeesCharged: report.movements.managementFeesCharged,
      // No insurance component on a קרן השתלמות. Section ב prints no such line,
      // and the balance equation closes exactly without one on every fixture —
      // which is also what would catch this being wrong, since a real insurance
      // cost read as absent would show up as drift the ±₪50 gate rejects.
      disabilityInsuranceCost: null,
      deathInsuranceCost: null,
      closingBalance: report.movements.closingBalance,
    },
    fees: {
      rateDeposit: null,
      rateSavings: report.fees.onSavings,
      fundAverageDeposit: null,
      fundAverageSavings: report.fees.fundAverageOnSavings,
      rateInvestmentExpenses: report.fees.investmentExpenses,
    },
    // Section א is two lump sums, both of which the document's own footnote
    // states are the closing balance restated ("*כולל את סך יתרת הכספים נכון
    // ל- …"). The balance is already stored; re-storing it under two more names
    // would add columns that can only ever disagree with it. The one figure in
    // that section carrying new information is the withdrawal date, above.
    projections: null,
    tracks: report.tracks,
    deposits: {
      rows: report.deposits.rows.map((row) => ({
        // No employer column; the employer is stated once in the page header
        // and is a property of the account, not of a row.
        employer: null,
        depositDate: row.depositDate,
        forMonth: row.forMonth,
        salary: row.salary,
        employeeContribution: row.employeeContribution,
        employerContribution: row.employerContribution,
        // No severance component. Guarded structurally at the header — see
        // UNSUPPORTED_COLUMN_TITLES — because `column_total:severance` compares
        // 0 against 0 here and so cannot notice the column appearing.
        severance: null,
        total: row.total,
      })),
      totals: report.deposits.totals ? { ...report.deposits.totals, severance: null } : null,
    },
  };
}

export const harelHishtalmutParser: DocumentParser<HarelHishtalmutReport> = {
  id: "harel_hishtalmut",
  version: 1,

  recognises(items) {
    const text = items.map((item) => item.text).join("\n");
    return (
      /^דוח (רבעוני|שנתי) בקרן השתלמות/m.test(text) &&
      /harel-(group|ins)\.co\.il/.test(text) &&
      /^יתרת הכספים בחשבון בסוף/m.test(text) &&
      /^ה\. פירוט הפקדות/m.test(text)
    );
  },

  parse(items) {
    const parsed = harelHishtalmutReportSchema.safeParse({
      ...parseHeader(items),
      movements: parseMovements(items),
      fees: parseFees(items),
      tracks: parseTracks(items),
      deposits: parseDeposits(items, parseDepositsPage),
    });
    if (!parsed.success) throw new DocumentParseError("malformed_document");
    return parsed.data;
  },
};
