/**
 * The normalised shape every long-term-savings report parser produces, and the
 * arithmetic checked against it.
 *
 * Until a second parser existed, promotion was typed directly to the Harel
 * pension report and called that parser's own check function. That worked for
 * exactly one document. The parsers stay faithful to their own page — Harel's
 * pension report and its קרן השתלמות report share a house style but not a
 * section list — and each maps its raw shape to this one, which is what the
 * domain layer stores.
 *
 * Every field a product genuinely lacks is nullable HERE and only here. That is
 * the load-bearing distinction: a `null` in this shape means "this document has
 * no such concept" (a קרן השתלמות has no death-insurance cost and no severance
 * column), while a `null` inside a parser's own raw shape means "a cell that
 * should have been read was not" and is rejected by that parser's Zod schema
 * before it ever gets here. Never widen a parser's schema to reach this one.
 *
 * Free of `pdfjs` — see pdf-text.ts. The domain layer imports this module, so
 * it must stay that way.
 */
import Decimal from "decimal.js";

export interface LongTermSavingsMovements {
  openingBalance: string;
  contributions: string;
  /** Signed: gains in a good period, losses in a bad one. */
  investmentResult: string;
  managementFeesCharged: string;
  /** Null on a product with no insurance component, e.g. קרן השתלמות. */
  disabilityInsuranceCost: string | null;
  deathInsuranceCost: string | null;
  closingBalance: string;
}

export interface LongTermSavingsFees {
  rateDeposit: string | null;
  rateSavings: string | null;
  fundAverageDeposit: string | null;
  fundAverageSavings: string | null;
  /** Investment-management expenses, printed only on some annual reports. */
  rateInvestmentExpenses: string | null;
}

/**
 * The report's own projection, computed from the CURRENT balance assuming no
 * future contributions. Null on a product that prints no such section.
 */
export interface LongTermSavingsProjections {
  retirementAge: number | null;
  monthlyPension: string | null;
  survivorPension: string | null;
  orphanPension: string | null;
  dependentParentPension: string | null;
  disabilityPension: string | null;
  contributionWaiver: string | null;
}

export interface LongTermSavingsTrack {
  name: string;
  returnPercent: string | null;
  expectedAnnualCostPercent: string | null;
}

export interface LongTermSavingsDepositRow {
  /** Null when the table has no employer column. */
  employer: string | null;
  depositDate: string;
  forMonth: string;
  salary: string | null;
  employeeContribution: string;
  employerContribution: string;
  /** Null when the product has no severance component, e.g. קרן השתלמות. */
  severance: string | null;
  total: string;
}

export interface LongTermSavingsDepositTotals {
  employeeContribution: string;
  employerContribution: string;
  severance: string | null;
  total: string;
}

export interface LongTermSavingsReport {
  fundName: string;
  /** `תאריך הדוח` — the snapshot's `as_of`. */
  reportDate: string;
  statedPeriodStart: string;
  statedPeriodEnd: string;
  quarter: number | null;
  year: number | null;
  /**
   * When the money becomes reachable, when the document states it. Only a
   * `liquid_after` product prints one; everything else leaves it null and takes
   * its liquidity from the product alone.
   */
  liquidFrom: string | null;
  movements: LongTermSavingsMovements;
  fees: LongTermSavingsFees;
  projections: LongTermSavingsProjections | null;
  tracks: LongTermSavingsTrack[];
  deposits: {
    rows: LongTermSavingsDepositRow[];
    totals: LongTermSavingsDepositTotals | null;
  };
}

/**
 * Arithmetic the document asserts about itself. Every figure on these reports
 * is rounded to the nearest shekel, so exact equality is not available — the
 * caller decides which of these gate a write and with what tolerance (D9); this
 * function only reports.
 */
export interface ReportCheck {
  name: string;
  drift: string;
  detail: string;
}

/**
 * One check function over the normalised shape rather than one per parser.
 *
 * The equations are the same for every product; what differs is which terms the
 * document prints, and an absent term is a genuine zero here — a קרן השתלמות
 * charges no death-insurance cost and has no severance column, so summing them
 * as zero is the document's own arithmetic, not a fabrication. What that costs
 * is real and has to be paid elsewhere: `column_total:severance` becomes 0 vs 0
 * on such a report, so it gates nothing. A parser for a product without a
 * column must therefore REFUSE a document that grows one, rather than rely on
 * this check to notice (see the hishtalmut parser's header guard).
 */
export function checkLongTermSavingsReport(report: LongTermSavingsReport): {
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
