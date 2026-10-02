/**
 * Parser for Analyst's quarterly קרן השתלמות report
 * ("דוח רבעוני לעמית בקרן השתלמות אנליסט קרן השתלמות").
 *
 * The same uniform sections as Harel's קרן השתלמות report, and section ה's
 * table is read by Harel's own page reader. What differs is how the page
 * arrives:
 *
 *   - The PDF emits Hebrew one GLYPH per text run (figures arrive whole), so
 *     nothing below can match a label until `mergeRuns` rebuilds the phrases.
 *   - Percentages arrive with their "%" in the same run ("0.63%").
 *   - The period line prints two-digit years ("01/01/26").
 *
 * Section ג also prints an account-wide expected annual cost ("עלות שנתית
 * צפויה"). The normalised shape has no account-level field for it, so it is
 * deliberately not read.
 *
 * Only one Analyst report has been seen, and its deposits table was empty
 * ("בתקופת הדוח לא היו הפקדות שוטפות"). An empty table is accepted only with
 * that sentence printed, and a table with rows only with its totals row — so
 * a layout the reader does not follow fails rather than storing nothing.
 */
import { z } from "zod";
import type { LongTermSavingsReport } from "../long-term-savings-report";
import { findLabel, mergeRuns, percentAt, type Item } from "../pdf-text";
import { parseDepositsPage } from "../harel/hishtalmut";
import {
  DATE,
  decimalString,
  isoDate,
  isoDateString,
  isoMonthString,
  parseDeposits,
  requiredValueAt,
} from "../harel/shared";
import { DocumentParseError, type DocumentParser } from "../types";
import { pageText, parseReturnTracks } from "../uniform-report";

// ------------------------------------------------------------------- shape

const movementsSchema = z.object({
  openingBalance: decimalString,
  contributions: decimalString,
  investmentResult: decimalString,
  managementFeesCharged: decimalString,
  closingBalance: decimalString,
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

export const analystHishtalmutReportSchema = z.object({
  fundName: z.string().min(1),
  reportDate: isoDateString,
  statedPeriodStart: isoDateString,
  statedPeriodEnd: isoDateString,
  quarter: z.number().int().min(1).max(4).nullable(),
  year: z.number().int(),
  /** Section א's "החל מ- …" — required, as on Harel's (see that parser). */
  liquidFrom: isoDateString,
  movements: movementsSchema,
  fees: z.object({
    onSavings: decimalString.nullable(),
    fundAverageOnSavings: decimalString.nullable(),
  }),
  tracks: z.array(z.object({ name: z.string().min(1), returnPercent: decimalString })),
  deposits: z.object({
    rows: z.array(depositRowSchema),
    totals: depositTotalsSchema.nullable(),
  }),
});

export type AnalystHishtalmutReport = z.infer<typeof analystHishtalmutReportSchema>;

// ------------------------------------------------------------------- header

/** Two- or four-digit-year `dd/mm/yy(yy)`, as this report prints both. */
const SHORT_DATE = String.raw`\d{2}\/\d{2}\/\d{2}(?:\d{2})?`;

function isoShortDate(text: string): string {
  return isoDate(text.replace(/^(\d{2}\/\d{2}\/)(\d{2})$/, "$120$2"));
}

function parseHeader(items: Item[]) {
  const text = pageText(items);
  const reportDate = text.match(new RegExp(String.raw`תאריך הדוח:\s*(${DATE})`));
  const title = text.match(/^דוח רבעוני לעמית בקרן השתלמות (.+)$/m);
  const period = text.match(
    new RegExp(String.raw`מתאריך\s*(${SHORT_DATE})\s*עד תאריך\s*(${SHORT_DATE})`),
  );
  const quarter = text.match(/לסוף הרבעון ה-\s*(\d)\s+לשנת\s+(\d{4})/);
  const liquidFrom = text.match(
    new RegExp(String.raw`יתרת הכספים המיועדים למשיכה חד פעמית החל מ-\s*(${DATE})`),
  );
  if (!reportDate || !title || !period || !quarter || !liquidFrom)
    throw new DocumentParseError("malformed_document");

  return {
    fundName: title[1].trim(),
    reportDate: isoDate(reportDate[1]),
    statedPeriodStart: isoShortDate(period[1]),
    statedPeriodEnd: isoShortDate(period[2]),
    quarter: Number(quarter[1]),
    year: Number(quarter[2]),
    liquidFrom: isoDate(liquidFrom[1]),
  };
}

// -------------------------------------------------------------- sections

/** Section ב — five lines, all required, as on Harel's קרן השתלמות report. */
function parseMovements(items: Item[]): z.infer<typeof movementsSchema> {
  return {
    openingBalance: requiredValueAt(items, /^יתרת הכספים בחשבון בתחילת/),
    contributions: requiredValueAt(items, /^כספים שהופקדו לחשבון$/),
    investmentResult: requiredValueAt(items, /^(רווחים|הפסדים) בניכוי הוצאות ניהול השקעות/),
    managementFeesCharged: requiredValueAt(items, /^דמי ניהול שנגבו/),
    closingBalance: requiredValueAt(items, /^יתרת הכספים בחשבון בסוף/),
  };
}

function parseDepositsSection(items: Item[]) {
  const deposits = parseDeposits(items, parseDepositsPage);
  const saysEmpty = findLabel(items, /^בתקופת הדוח לא היו הפקדות/) !== undefined;
  if (deposits.rows.length === 0 ? !saysEmpty : deposits.totals === null)
    throw new DocumentParseError("malformed_document");
  return deposits;
}

// ------------------------------------------------------------------ parser

export function normaliseAnalystHishtalmut(report: AnalystHishtalmutReport): LongTermSavingsReport {
  return {
    fundName: report.fundName,
    reportDate: report.reportDate,
    statedPeriodStart: report.statedPeriodStart,
    statedPeriodEnd: report.statedPeriodEnd,
    quarter: report.quarter,
    year: report.year,
    liquidFrom: report.liquidFrom,
    movements: {
      ...report.movements,
      // No insurance, transfer or actuarial line on a קרן השתלמות report; the
      // balance equation closes exactly without them.
      disabilityInsuranceCost: null,
      deathInsuranceCost: null,
      transfersIn: null,
      actuarialAdjustment: null,
    },
    fees: {
      rateDeposit: null,
      rateSavings: report.fees.onSavings,
      fundAverageDeposit: null,
      fundAverageSavings: report.fees.fundAverageOnSavings,
      rateInvestmentExpenses: null,
    },
    // Section א is the closing balance restated twice, as on Harel's.
    projections: null,
    tracks: report.tracks.map((track) => ({ ...track, expectedAnnualCostPercent: null })),
    deposits: {
      rows: report.deposits.rows.map((row) => ({ ...row, employer: null, severance: null })),
      totals: report.deposits.totals ? { ...report.deposits.totals, severance: null } : null,
    },
  };
}

export const analystHishtalmutParser: DocumentParser<AnalystHishtalmutReport> = {
  id: "analyst_hishtalmut",
  version: 1,

  recognises(raw) {
    const text = mergeRuns(raw)
      .map((item) => item.text)
      .join("\n");
    return (
      /^דוח רבעוני לעמית בקרן השתלמות/m.test(text) &&
      /analyst\.co\.il/.test(text) &&
      /^יתרת הכספים בחשבון בסוף/m.test(text)
    );
  },

  parse(raw) {
    const items = mergeRuns(raw);
    const parsed = analystHishtalmutReportSchema.safeParse({
      ...parseHeader(items),
      movements: parseMovements(items),
      fees: {
        onSavings: percentAt(items, /^דמי ניהול מחיסכון$/),
        // The left-margin "ממוצע דמי ניהול בקופה" box, labelled by the bare word.
        fundAverageOnSavings: percentAt(items, /^מחיסכון$/),
      },
      tracks: parseReturnTracks(items),
      deposits: parseDepositsSection(items),
    });
    if (!parsed.success) throw new DocumentParseError("malformed_document");
    return parsed.data;
  },
};
