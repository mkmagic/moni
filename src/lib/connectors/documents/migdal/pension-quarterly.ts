/**
 * Parser for Migdal's quarterly new-pension-fund report
 * ("דוח רבעוני לעמית בקרן הפנסיה החדשה 'מגדל מקפת אישית'").
 *
 * Same uniform sections as Harel's pension report, read differently:
 *
 *   - The PDF emits one text run per WORD, so labels exist only after
 *     `mergeRuns` rebuilds them. Everything below reads the merged items.
 *   - Section ב has two lines Harel's has not: money transferred in from
 *     another fund ("כספים שהעברת לקרן") and the actuarial-balancing adjustment.
 *     Both are part of the balance equation; without them it misses by the
 *     whole transfer.
 *   - Section ב leaves a line's cell BLANK when the figure is nil — the opening
 *     balance in a fund's first year, an insurance line the member does not
 *     carry. Only those lines may be blank; the balance equation gates them,
 *     since a real figure misread as blank shows up as drift.
 *   - Section ה lists "ריסק מצבירה" rows — risk premiums drawn from savings in a
 *     month with no deposit. They are not deposits: the printed totals and
 *     section ב's contributions both exclude them, so the parser does too.
 *
 * Money is a decimal string end to end. The member's name and ת.ז. are never
 * extracted.
 */
import { z } from "zod";
import type { LongTermSavingsReport } from "../long-term-savings-report";
import {
  depositColumns,
  findLabel,
  groupRows,
  isNumber,
  joinRtl,
  mergeRuns,
  numberLeftOf,
  percentAt,
  toDecimalString,
  valueAt,
  type Column,
  type Item,
} from "../pdf-text";
import {
  DATE,
  TOTALS_CELL,
  decimalString,
  isoDate,
  isoDateString,
  isoMonth,
  isoMonthString,
  parseDeposits,
  requiredValueAt,
} from "../harel/shared";
import { DocumentParseError, type DocumentParser } from "../types";
import { pageText, parseReturnTracks } from "../uniform-report";

// ------------------------------------------------------------------- shape

const expectedPaymentsSchema = z.object({
  retirementAge: z.number().int().nullable(),
  monthlyPensionAtRetirement: decimalString.nullable(),
  monthlySurvivorPension: decimalString.nullable(),
  monthlyOrphanPension: decimalString.nullable(),
  monthlyDependentParentPension: decimalString.nullable(),
  monthlyFullDisabilityPension: decimalString.nullable(),
  contributionWaiverOnDisability: decimalString.nullable(),
});

/** Section ב, year-to-date (D6). Nullable fields are the lines Migdal blanks when nil. */
const movementsSchema = z.object({
  openingBalance: decimalString.nullable(),
  contributions: decimalString,
  investmentResult: decimalString,
  transfersIn: decimalString.nullable(),
  managementFeesCharged: decimalString,
  disabilityInsuranceCost: decimalString.nullable(),
  deathInsuranceCost: decimalString.nullable(),
  actuarialAdjustment: decimalString.nullable(),
  closingBalance: decimalString,
});

const managementFeesSchema = z.object({
  onDeposit: decimalString.nullable(),
  onSavings: decimalString.nullable(),
  fundAverageOnDeposit: decimalString.nullable(),
  fundAverageOnSavings: decimalString.nullable(),
});

const trackSchema = z.object({
  name: z.string().min(1),
  returnPercent: decimalString,
});

const depositRowSchema = z.object({
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

export const migdalPensionReportSchema = z.object({
  fundName: z.string().min(1),
  reportDate: isoDateString,
  statedPeriodStart: isoDateString,
  statedPeriodEnd: isoDateString,
  quarter: z.number().int().min(1).max(4).nullable(),
  year: z.number().int(),
  expectedPayments: expectedPaymentsSchema,
  movements: movementsSchema,
  managementFees: managementFeesSchema,
  tracks: z.array(trackSchema),
  deposits: z.object({
    rows: z.array(depositRowSchema),
    totals: depositTotalsSchema.nullable(),
  }),
});

export type MigdalPensionReport = z.infer<typeof migdalPensionReportSchema>;

// ------------------------------------------------------------------ anchors

/** The deposits table's own titles — see the Harel parsers for why geometry alone is not enough. */
const COLUMN_TITLES = [
  /^שם המעסיק/,
  /^מועד/,
  /^עבור חודש/,
  /^משכורת$/,
  /^תגמולי עובד/,
  /^תגמולי מעסיק$/,
  /^פיצויים$/,
  /^סה"כ/,
];

/** Section-ה rows that are not deposits (see the header comment). */
const NOT_A_DEPOSIT = /^ריסק מצבירה$/;

// ------------------------------------------------------------------- header

function parseHeader(items: Item[]) {
  const text = pageText(items);
  const reportDate = text.match(new RegExp(String.raw`תאריך הדוח:\s*(${DATE})`));
  const title = text.match(/^דוח רבעוני לעמית בקרן הפנסיה החדשה '(.+?)'/m);
  const period = text.match(new RegExp(String.raw`מתאריך\s*(${DATE})\s*עד תאריך\s*(${DATE})`));
  const quarter = text.match(/לסוף הרבעון ה-\s*(\d)\s+לשנת\s+(\d{4})/);
  if (!reportDate || !title || !period || !quarter)
    throw new DocumentParseError("malformed_document");

  return {
    fundName: title[1].trim(),
    reportDate: isoDate(reportDate[1]),
    statedPeriodStart: isoDate(period[1]),
    statedPeriodEnd: isoDate(period[2]),
    quarter: Number(quarter[1]),
    year: Number(quarter[2]),
  };
}

// -------------------------------------------------- sections א / ב / ג / ד

function parseExpectedPayments(items: Item[]): z.infer<typeof expectedPaymentsSchema> {
  // "…בפרישה בגיל" is followed by the age as its own figure, then the amount
  // to the left of that — so the amount is the number left of the AGE.
  const retirementLabel = findLabel(items, /^קצבה חודשית הצפויה לך בפרישה בגיל$/);
  const age = retirementLabel ? numberLeftOf(items, retirementLabel) : null;
  const ageItem = age
    ? items.find((item) => item.text === age && retirementLabel && item.y === retirementLabel.y)
    : undefined;
  return {
    retirementAge: age ? Number(age) : null,
    monthlyPensionAtRetirement: ageItem ? numberLeftOf(items, ageItem) : null,
    monthlySurvivorPension: valueAt(items, /^קצבה חודשית לאלמן/),
    monthlyOrphanPension: valueAt(items, /^קצבה חודשית ליתום/),
    monthlyDependentParentPension: valueAt(items, /^קצבה חודשית להורה נתמך/),
    monthlyFullDisabilityPension: valueAt(items, /^קצבה חודשית במקרה של נכות/),
    contributionWaiverOnDisability: valueAt(items, /^שחרור מתשלום הפקדות/),
  };
}

function parseMovements(items: Item[]): z.infer<typeof movementsSchema> {
  // The opening line must be there even when its cell is blank — a missing
  // label means the layout moved, not that the fund is new.
  if (!findLabel(items, /^יתרת הכספים בקרן בתחילת/))
    throw new DocumentParseError("malformed_document");
  return {
    openingBalance: valueAt(items, /^יתרת הכספים בקרן בתחילת/),
    contributions: requiredValueAt(items, /^כספים שהופקדו לקרן$/),
    investmentResult: requiredValueAt(items, /^(רווחים|הפסדים) בניכוי הוצאות ניהול השקעות/),
    transfersIn: valueAt(items, /^כספים שהעברת לקרן$/),
    managementFeesCharged: requiredValueAt(items, /^דמי ניהול שנגבו/),
    disabilityInsuranceCost: valueAt(items, /^עלות ביטוח לסיכוני נכות/),
    deathInsuranceCost: valueAt(items, /^עלות ביטוח למקרה מוות/),
    actuarialAdjustment: valueAt(items, /^עדכון יתרת הכספים בגין הפעלת/),
    // "יתרת הכספים בקרן ב- 30/06/2026": the date is its own run, so the
    // balance is still the nearest NUMBER to the label's left.
    closingBalance: requiredValueAt(items, /^יתרת הכספים בקרן ב-$/),
  };
}

function parseManagementFees(items: Item[]): z.infer<typeof managementFeesSchema> {
  return {
    onDeposit: percentAt(items, /^דמי ניהול מהפקדה$/),
    onSavings: percentAt(items, /^דמי ניהול מחיסכון$/),
    // The left-margin "ממוצע דמי ניהול בקרן" box, labelled by the bare words.
    fundAverageOnDeposit: percentAt(items, /^מהפקדה$/),
    fundAverageOnSavings: percentAt(items, /^מחיסכון$/),
  };
}

// ------------------------------------------------------- section ה (table)

interface DepositRowCandidate {
  employer: string;
  depositDate: string;
  forMonth: string;
  salary: string | null;
  employeeContribution: string | null;
  employerContribution: string | null;
  severance: string | null;
  total: string | null;
}

type DepositTotalsCandidate = Record<keyof z.infer<typeof depositTotalsSchema>, string | null>;

function parseDepositsPage(
  items: Item[],
  anchor: Item,
): { rows: DepositRowCandidate[]; totals: DepositTotalsCandidate | null } {
  const columns = depositColumns(items, anchor);
  const named = columns.filter((column) => COLUMN_TITLES.some((title) => title.test(column.title)));
  if (named.length < 2) throw new DocumentParseError("malformed_document");

  // Half the pitch to each column's own nearest neighbour — the per-column
  // bound the Harel קרן השתלמות parser explains. Migdal right-aligns its
  // figures about 14pt off each column's centre, well inside it.
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
      return nearest === column && Math.abs(nearest.centre - item.centre) <= limit;
    });
  };

  const leftmost = named[named.length - 1];
  const body = items.filter(
    (item) =>
      item.page === anchor.page &&
      item.y < anchor.y - 14 &&
      // The left margin's "check your payslip" box shares the rows' baselines.
      item.centre >= leftmost.centre - (reach.get(leftmost) ?? 0),
  );

  const rows: DepositRowCandidate[] = [];
  for (const row of groupRows(body)) {
    const num = (pattern: RegExp): string | null => {
      const cell = cellIn(row, pattern);
      return cell && isNumber(cell) ? toDecimalString(cell.text) : null;
    };

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

    const employer = joinRtl(
      row.filter((item) => !isNumber(item) && item !== date && item !== month),
    );
    if (NOT_A_DEPOSIT.test(employer)) continue;

    rows.push({
      employer,
      depositDate: isoDate(date.text),
      forMonth: isoMonth(month.text),
      salary: num(/^משכורת$/),
      // Never defaulted: a blank money cell on a real deposit row is a misread
      // and the schema rejects it.
      employeeContribution: num(/^תגמולי עובד/),
      employerContribution: num(/^תגמולי מעסיק$/),
      severance: num(/^פיצויים$/),
      total: num(/^סה"כ/),
    });
  }
  return { rows, totals: null };
}

/**
 * Rows without a totals row are refused: the column-total checks — the only
 * gate on this table — need the printed totals, and silently skip without them.
 */
function parseDepositsSection(items: Item[]) {
  const deposits = parseDeposits(items, parseDepositsPage);
  if (deposits.rows.length > 0 && deposits.totals === null)
    throw new DocumentParseError("malformed_document");
  return deposits;
}

// ------------------------------------------------------------------ parser

export function normaliseMigdalPension(report: MigdalPensionReport): LongTermSavingsReport {
  const m = report.movements;
  return {
    fundName: report.fundName,
    reportDate: report.reportDate,
    statedPeriodStart: report.statedPeriodStart,
    statedPeriodEnd: report.statedPeriodEnd,
    quarter: report.quarter,
    year: report.year,
    liquidFrom: null,
    movements: {
      // A blank opening cell is the fund's first year — nothing to open with.
      // The balance equation is what makes this safe: a real opening balance
      // misread as blank would miss by itself and fail the ±₪50 gate.
      openingBalance: m.openingBalance ?? "0",
      contributions: m.contributions,
      investmentResult: m.investmentResult,
      managementFeesCharged: m.managementFeesCharged,
      disabilityInsuranceCost: m.disabilityInsuranceCost,
      deathInsuranceCost: m.deathInsuranceCost,
      transfersIn: m.transfersIn,
      actuarialAdjustment: m.actuarialAdjustment,
      closingBalance: m.closingBalance,
    },
    fees: {
      rateDeposit: report.managementFees.onDeposit,
      rateSavings: report.managementFees.onSavings,
      fundAverageDeposit: report.managementFees.fundAverageOnDeposit,
      fundAverageSavings: report.managementFees.fundAverageOnSavings,
      rateInvestmentExpenses: null,
    },
    projections: {
      retirementAge: report.expectedPayments.retirementAge,
      monthlyPension: report.expectedPayments.monthlyPensionAtRetirement,
      survivorPension: report.expectedPayments.monthlySurvivorPension,
      orphanPension: report.expectedPayments.monthlyOrphanPension,
      dependentParentPension: report.expectedPayments.monthlyDependentParentPension,
      disabilityPension: report.expectedPayments.monthlyFullDisabilityPension,
      contributionWaiver: report.expectedPayments.contributionWaiverOnDisability,
    },
    tracks: report.tracks.map((track) => ({ ...track, expectedAnnualCostPercent: null })),
    deposits: {
      rows: report.deposits.rows.map((row) => ({ ...row, employer: row.employer || null })),
      totals: report.deposits.totals,
    },
  };
}

export const migdalPensionQuarterlyParser: DocumentParser<MigdalPensionReport> = {
  id: "migdal_pension_quarterly",
  version: 1,

  recognises(raw) {
    const text = mergeRuns(raw)
      .map((item) => item.text)
      .join("\n");
    return (
      /^דוח רבעוני לעמית בקרן הפנסיה החדשה/m.test(text) &&
      /migdal\.co\.il/.test(text) &&
      /^יתרת הכספים בקרן ב-$/m.test(text)
    );
  },

  parse(raw) {
    const items = mergeRuns(raw);
    const parsed = migdalPensionReportSchema.safeParse({
      ...parseHeader(items),
      expectedPayments: parseExpectedPayments(items),
      movements: parseMovements(items),
      managementFees: parseManagementFees(items),
      tracks: parseReturnTracks(items),
      deposits: parseDepositsSection(items),
    });
    if (!parsed.success) throw new DocumentParseError("malformed_document");
    return parsed.data;
  },
};
