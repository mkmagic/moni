import Decimal from "decimal.js";
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";

import { withUser, type UserTransaction } from "@/db/client";
import {
  investmentActivityCoverage,
  investmentActivityEvidence,
  investmentCorporateActionEvidence,
  investmentDisposalResolutionQueue,
  investmentLotClosures,
  investmentReconciliationQuality,
  investmentSnapshotDetails,
  investmentSnapshotPositions,
  investmentTaxLots,
} from "@/db/schema";
import { decText } from "./fields";
import { usableIlsRate } from "./ils-rate";
import { BROKER_ELSE_USER_POLICY_VERSION } from "./investment-lots";
import { israelDate, valueInvestmentSnapshot } from "./investment-valuation";

type Tx = UserTransaction;
export type InvestmentMetricCompleteness = "complete" | "partial" | "unknown";

export interface InvestmentMetricQuality {
  completeness: InvestmentMetricCompleteness;
  provenance: string[];
  valuationAsOf: string | null;
  fxAsOf: string | null;
}

export interface InvestmentMoneyFigure {
  amount: string;
  currency: string;
  basis: "ils_gain_includes_fx" | "native_price_gain" | "booked_cash_income";
}

export interface InvestmentRateFigure {
  rate: string | null;
  basis: "time_weighted_return_ils" | "money_weighted_return_ils_irr";
}

export interface InvestmentRealizedGain {
  ils: InvestmentMoneyFigure;
  native: InvestmentMoneyFigure[];
  closureCount: number;
  quality: InvestmentMetricQuality;
}

export interface InvestmentUnrealizedGain {
  ils: InvestmentMoneyFigure;
  native: InvestmentMoneyFigure[];
  quality: InvestmentMetricQuality;
}

export interface InvestmentPerformance {
  twr: InvestmentRateFigure & { quality: InvestmentMetricQuality };
  mwr: InvestmentRateFigure & { quality: InvestmentMetricQuality };
}

export interface InvestmentDividendIncome {
  ils: InvestmentMoneyFigure;
  native: InvestmentMoneyFigure[];
  bookedCashCount: number;
  quality: InvestmentMetricQuality;
}

export interface InvestmentReturnsRead {
  realizedGain: InvestmentRealizedGain;
  unrealizedGain: InvestmentUnrealizedGain;
  performance: InvestmentPerformance;
  dividendIncome: InvestmentDividendIncome;
}

export interface InvestmentReturnsInput {
  userId: string;
  accountId: string;
  instrumentId?: string;
  startDate?: string;
  endDate?: string;
  policyVersion?: string;
  now?: Date;
  /** Tier-1 data key. The caller owns its lifetime and wiping. */
  dataKey: Uint8Array;
}

interface RequiredInput extends InvestmentReturnsInput {
  policyVersion: string;
  now: Date;
}

function dateInRange(date: string, input: RequiredInput): boolean {
  return (!input.startDate || date >= input.startDate) && (!input.endDate || date <= input.endDate);
}

function nativeFigures(
  totals: Map<string, Decimal>,
  basis: "native_price_gain" | "booked_cash_income",
): InvestmentMoneyFigure[] {
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, amount]) => ({ amount: amount.toFixed(), currency, basis }));
}

function mergeCompleteness(values: InvestmentMetricCompleteness[]): InvestmentMetricCompleteness {
  if (values.length === 0 || values.includes("unknown")) return "unknown";
  return values.includes("partial") ? "partial" : "complete";
}

async function metricQuality(
  tx: Tx,
  input: RequiredInput,
  metric: "cost_basis" | "realized_gain" | "unrealized_gain" | "dividends" | "twr" | "mwr",
  provenance: Set<string>,
  valuationAsOf: string | null,
  fxDates: string[],
  forcedPartial = false,
): Promise<InvestmentMetricQuality> {
  const rows = await tx
    .select()
    .from(investmentActivityCoverage)
    .where(eq(investmentActivityCoverage.accountId, input.accountId));
  const relevant = rows.filter(
    (row) =>
      (row.metric === metric ||
        ((metric === "realized_gain" || metric === "unrealized_gain") &&
          row.metric === "cost_basis")) &&
      (!input.instrumentId || row.instrumentId === null || row.instrumentId === input.instrumentId),
  );
  let completeness = mergeCompleteness(relevant.map((row) => row.completeness));
  const pending = await tx
    .select({ kind: investmentDisposalResolutionQueue.kind })
    .from(investmentDisposalResolutionQueue)
    .where(
      and(
        eq(investmentDisposalResolutionQueue.accountId, input.accountId),
        eq(investmentDisposalResolutionQueue.status, "pending"),
      ),
    );
  const corporateActions = await tx
    .select({ instrumentId: investmentCorporateActionEvidence.instrumentId })
    .from(investmentCorporateActionEvidence)
    .where(eq(investmentCorporateActionEvidence.accountId, input.accountId));
  const reconciliation = await tx
    .select({ instrumentId: investmentReconciliationQuality.instrumentId })
    .from(investmentReconciliationQuality)
    .where(
      and(
        eq(investmentReconciliationQuality.accountId, input.accountId),
        eq(investmentReconciliationQuality.status, "pending"),
      ),
    );
  const hasScopedCorporateAction = corporateActions.some(
    (row) =>
      !input.instrumentId || row.instrumentId === null || row.instrumentId === input.instrumentId,
  );
  const hasScopedReconciliation = reconciliation.some(
    (row) =>
      !input.instrumentId || row.instrumentId === null || row.instrumentId === input.instrumentId,
  );
  const unresolvedDisposal = pending.some((row) => row.kind === "unresolved_disposal");
  if (
    forcedPartial ||
    hasScopedCorporateAction ||
    hasScopedReconciliation ||
    ((metric === "realized_gain" ||
      metric === "unrealized_gain" ||
      metric === "twr" ||
      metric === "mwr") &&
      unresolvedDisposal)
  ) {
    completeness = completeness === "unknown" ? "unknown" : "partial";
  }
  return {
    completeness,
    provenance: [...provenance].sort(),
    valuationAsOf,
    fxAsOf: fxDates.sort().at(-1) ?? null,
  };
}

function lockedRate(currency: string, value: string | null): Decimal | null {
  if (currency === "ILS") return new Decimal(1);
  return value === null ? null : new Decimal(value);
}

async function realizedGain(tx: Tx, input: RequiredInput): Promise<InvestmentRealizedGain> {
  let lots = await tx
    .select()
    .from(investmentTaxLots)
    .where(
      and(
        eq(investmentTaxLots.accountId, input.accountId),
        eq(investmentTaxLots.policyVersion, input.policyVersion),
      ),
    );
  if (input.instrumentId) lots = lots.filter((lot) => lot.instrumentId === input.instrumentId);
  const lotById = new Map(lots.map((lot) => [lot.id, lot]));
  const closures = lots.length
    ? await tx
        .select()
        .from(investmentLotClosures)
        .where(
          inArray(
            investmentLotClosures.closedTaxLotId,
            lots.map((lot) => lot.id),
          ),
        )
    : [];
  const saleIds = [...new Set(closures.map((row) => row.sellActivityEvidenceId))];
  const sales = saleIds.length
    ? await tx
        .select()
        .from(investmentActivityEvidence)
        .where(inArray(investmentActivityEvidence.id, saleIds))
    : [];
  const saleById = new Map(sales.map((row) => [row.id, row]));
  const native = new Map<string, Decimal>();
  const provenance = new Set<string>();
  const fxDates: string[] = [];
  let ils = new Decimal(0);
  let count = 0;
  let incompleteFx = false;
  for (const closure of closures) {
    const sale = saleById.get(closure.sellActivityEvidenceId);
    const lot = lotById.get(closure.closedTaxLotId);
    if (!sale || !lot || !dateInRange(sale.tradeDate, input)) continue;
    const proceeds = new Decimal(
      decText(input.dataKey, closure.proceedsCt, closure.id, "proceeds_ct", closure.version)!,
    );
    const cost = new Decimal(
      decText(
        input.dataKey,
        closure.realizedCostBasisCt,
        closure.id,
        "realized_cost_basis_ct",
        closure.version,
      )!,
    );
    const saleCurrency = sale.currency;
    if (saleCurrency && saleCurrency === lot.costBasisCurrency) {
      native.set(
        saleCurrency,
        (native.get(saleCurrency) ?? new Decimal(0)).plus(proceeds.minus(cost)),
      );
    } else {
      incompleteFx = true;
    }
    const saleFx = lockedRate(
      saleCurrency ?? "",
      decText(
        input.dataKey,
        closure.lockedFxRateCt,
        closure.id,
        "locked_fx_rate_ct",
        closure.version,
      ),
    );
    const acquisitionFx = lockedRate(
      lot.costBasisCurrency,
      decText(input.dataKey, lot.lockedFxRateCt, lot.id, "locked_fx_rate_ct", lot.version),
    );
    if (saleFx && acquisitionFx) {
      ils = ils.plus(proceeds.mul(saleFx).minus(cost.mul(acquisitionFx)));
      if (closure.lockedFxObservationDate) fxDates.push(closure.lockedFxObservationDate);
      if (lot.lockedFxObservationDate) fxDates.push(lot.lockedFxObservationDate);
    } else {
      incompleteFx = true;
    }
    provenance.add(sale.provenance);
    provenance.add(`disposal_fx:${closure.lockedFxProvenance}`);
    provenance.add(`acquisition_fx:${lot.lockedFxProvenance}`);
    count += 1;
  }
  return {
    ils: { amount: ils.toFixed(), currency: "ILS", basis: "ils_gain_includes_fx" },
    native: nativeFigures(native, "native_price_gain"),
    closureCount: count,
    quality: await metricQuality(
      tx,
      input,
      "realized_gain",
      provenance,
      null,
      fxDates,
      incompleteFx,
    ),
  };
}

async function latestSnapshot(
  tx: Tx,
  input: RequiredInput,
): Promise<typeof investmentSnapshotDetails.$inferSelect | null> {
  const rows = await tx
    .select()
    .from(investmentSnapshotDetails)
    .where(eq(investmentSnapshotDetails.accountId, input.accountId))
    .orderBy(asc(investmentSnapshotDetails.sourceAsOf));
  return (
    rows.filter((row) => !input.endDate || israelDate(row.sourceAsOf) <= input.endDate).at(-1) ??
    null
  );
}

async function unrealizedGain(tx: Tx, input: RequiredInput): Promise<InvestmentUnrealizedGain> {
  const snapshot = await latestSnapshot(tx, input);
  const provenance = new Set<string>();
  const native = new Map<string, Decimal>();
  const fxDates: string[] = [];
  let ils = new Decimal(0);
  let incomplete = false;
  if (!snapshot) {
    return {
      ils: { amount: "0", currency: "ILS", basis: "ils_gain_includes_fx" },
      native: [],
      quality: await metricQuality(tx, input, "unrealized_gain", provenance, null, [], true),
    };
  }
  let positions = await tx
    .select()
    .from(investmentSnapshotPositions)
    .where(eq(investmentSnapshotPositions.snapshotId, snapshot.id));
  if (input.instrumentId)
    positions = positions.filter((position) => position.instrumentId === input.instrumentId);
  let lots = await tx
    .select()
    .from(investmentTaxLots)
    .where(
      and(
        eq(investmentTaxLots.accountId, input.accountId),
        eq(investmentTaxLots.policyVersion, input.policyVersion),
      ),
    );
  if (input.instrumentId) lots = lots.filter((lot) => lot.instrumentId === input.instrumentId);
  const currentDate = input.endDate ?? israelDate(input.now);
  for (const position of positions) {
    const quantity = new Decimal(
      decText(input.dataKey, position.quantityCt, position.id, "quantity_ct", position.version)!,
    );
    const sourceValue = decText(
      input.dataKey,
      position.sourceValueCt,
      position.id,
      "source_value_ct",
      position.version,
    );
    const sourcePrice = decText(
      input.dataKey,
      position.sourcePriceCt,
      position.id,
      "source_price_ct",
      position.version,
    );
    const value = sourceValue
      ? new Decimal(sourceValue)
      : sourcePrice
        ? quantity.mul(sourcePrice)
        : null;
    const valueCurrency =
      position.sourceValueCurrency ?? position.sourcePriceCurrency ?? position.currency;
    if (!value) {
      incomplete = true;
      continue;
    }
    let nativeBasis = new Decimal(0);
    let ilsBasis = new Decimal(0);
    let coveredQuantity = new Decimal(0);
    for (const lot of lots.filter((row) => row.instrumentId === position.instrumentId)) {
      const original = new Decimal(
        decText(
          input.dataKey,
          lot.originalQuantityCt,
          lot.id,
          "original_quantity_ct",
          lot.version,
        )!,
      );
      const remaining = new Decimal(
        decText(
          input.dataKey,
          lot.remainingQuantityCt,
          lot.id,
          "remaining_quantity_ct",
          lot.version,
        )!,
      );
      coveredQuantity = coveredQuantity.plus(remaining);
      const openBasis = new Decimal(
        decText(input.dataKey, lot.costBasisCt, lot.id, "cost_basis_ct", lot.version)!,
      )
        .mul(remaining)
        .div(original);
      if (lot.costBasisCurrency === valueCurrency) nativeBasis = nativeBasis.plus(openBasis);
      else incomplete = true;
      const rate = lockedRate(
        lot.costBasisCurrency,
        decText(input.dataKey, lot.lockedFxRateCt, lot.id, "locked_fx_rate_ct", lot.version),
      );
      if (rate) {
        ilsBasis = ilsBasis.plus(openBasis.mul(rate));
        if (lot.lockedFxObservationDate) fxDates.push(lot.lockedFxObservationDate);
      } else incomplete = true;
      provenance.add(`acquisition_fx:${lot.lockedFxProvenance}`);
    }
    // Derived lots may not explain the full snapshot position (the normal D3
    // coverage-gap case). Prorate market value to the quantity the lots cover so
    // uncovered shares are not booked as pure zero-basis gain, and mark the
    // figure partial even before reconciliation runs.
    const coveredValue = coveredQuantity.equals(quantity)
      ? value
      : quantity.isZero()
        ? new Decimal(0)
        : value.mul(coveredQuantity).div(quantity);
    if (!coveredQuantity.equals(quantity)) incomplete = true;
    native.set(
      valueCurrency,
      (native.get(valueCurrency) ?? new Decimal(0)).plus(coveredValue.minus(nativeBasis)),
    );
    const currentFx = await usableIlsRate(tx, valueCurrency, currentDate);
    if (currentFx) {
      ils = ils.plus(coveredValue.mul(currentFx.rate).minus(ilsBasis));
      fxDates.push(currentFx.date);
      provenance.add(valueCurrency === "ILS" ? "current_fx:identity" : "current_fx:boi");
    } else incomplete = true;
  }
  provenance.add(`snapshot:${snapshot.source}`);
  return {
    ils: { amount: ils.toFixed(), currency: "ILS", basis: "ils_gain_includes_fx" },
    native: nativeFigures(native, "native_price_gain"),
    quality: await metricQuality(
      tx,
      input,
      "unrealized_gain",
      provenance,
      snapshot.sourceAsOf.toISOString(),
      fxDates,
      incomplete,
    ),
  };
}

export function calculateTimeWeightedReturn(
  valuations: Array<{ date: string; value: string }>,
  externalFlows: Array<{ date: string; amount: string }>,
): string | null {
  if (valuations.length < 2) return null;
  const points = [...valuations].sort((left, right) => left.date.localeCompare(right.date));
  let factor = new Decimal(1);
  for (let index = 1; index < points.length; index += 1) {
    const start = new Decimal(points[index - 1].value);
    if (start.isZero()) return null;
    const flow = externalFlows
      .filter((item) => item.date > points[index - 1].date && item.date <= points[index].date)
      .reduce((sum, item) => sum.plus(item.amount), new Decimal(0));
    factor = factor.mul(new Decimal(points[index].value).minus(flow).div(start));
  }
  return factor.minus(1).toFixed();
}

function xnpv(rate: Decimal, flows: Array<{ date: string; amount: string }>): Decimal {
  const first = Date.parse(`${flows[0].date}T00:00:00Z`);
  return flows.reduce((total, flow) => {
    const days = Math.trunc((Date.parse(`${flow.date}T00:00:00Z`) - first) / 86_400_000);
    const years = new Decimal(String(days)).div(365);
    return total.plus(new Decimal(flow.amount).div(rate.plus(1).pow(years)));
  }, new Decimal(0));
}

export function calculateMoneyWeightedReturn(
  datedFlows: Array<{ date: string; amount: string }>,
): string | null {
  if (datedFlows.length < 2) return null;
  const flows = [...datedFlows].sort((left, right) => left.date.localeCompare(right.date));
  if (
    !flows.some((flow) => new Decimal(flow.amount).isNegative()) ||
    !flows.some((flow) => new Decimal(flow.amount).isPositive())
  )
    return null;
  let low = new Decimal("-0.999999999999");
  let high = new Decimal(1);
  let lowValue = xnpv(low, flows);
  let highValue = xnpv(high, flows);
  for (let index = 0; lowValue.mul(highValue).isPositive() && index < 32; index += 1) {
    high = high.plus(1).mul(2).minus(1);
    highValue = xnpv(high, flows);
  }
  if (lowValue.mul(highValue).isPositive()) return null;
  for (let index = 0; index < 160; index += 1) {
    const middle = low.plus(high).div(2);
    const middleValue = xnpv(middle, flows);
    if (middleValue.abs().lte("1e-40")) return middle.toFixed();
    if (lowValue.mul(middleValue).lte(0)) {
      high = middle;
    } else {
      low = middle;
      lowValue = middleValue;
    }
  }
  return low.plus(high).div(2).toFixed();
}

async function externalFlows(
  tx: Tx,
  input: RequiredInput,
): Promise<{
  ils: Array<{ date: string; amount: string }>;
  provenance: Set<string>;
  fxDates: string[];
  incomplete: boolean;
}> {
  const activities = await tx
    .select()
    .from(investmentActivityEvidence)
    .where(
      and(
        eq(investmentActivityEvidence.accountId, input.accountId),
        gte(investmentActivityEvidence.tradeDate, input.startDate ?? "0001-01-01"),
        lte(investmentActivityEvidence.tradeDate, input.endDate ?? "9999-12-31"),
      ),
    );
  const ils: Array<{ date: string; amount: string }> = [];
  const provenance = new Set<string>();
  const fxDates: string[] = [];
  let incomplete = false;
  for (const row of activities) {
    if (
      row.activityType !== "deposit" &&
      row.activityType !== "withdrawal" &&
      row.activityType !== "transfer"
    )
      continue;
    const amountText = decText(
      input.dataKey,
      row.netCashAmountCt,
      row.id,
      "net_cash_amount_ct",
      row.version,
    );
    if (!amountText || !row.currency) {
      incomplete = true;
      continue;
    }
    const rate = await usableIlsRate(tx, row.currency, row.tradeDate);
    if (!rate) {
      incomplete = true;
      continue;
    }
    ils.push({ date: row.tradeDate, amount: new Decimal(amountText).mul(rate.rate).toFixed() });
    provenance.add(row.provenance);
    fxDates.push(rate.date);
  }
  return { ils, provenance, fxDates, incomplete };
}

async function performance(tx: Tx, input: RequiredInput): Promise<InvestmentPerformance> {
  const snapshots = await tx
    .select()
    .from(investmentSnapshotDetails)
    .where(eq(investmentSnapshotDetails.accountId, input.accountId))
    .orderBy(asc(investmentSnapshotDetails.sourceAsOf));
  const selected = snapshots.filter((row) => dateInRange(israelDate(row.sourceAsOf), input));
  const valuations: Array<{ date: string; value: string }> = [];
  const provenance = new Set<string>();
  let valuationIncomplete = false;
  for (const snapshot of selected) {
    const value = await valueInvestmentSnapshot(tx, input.dataKey, snapshot.id, {
      now: snapshot.sourceAsOf,
      estimateNow: false,
    });
    valuations.push({ date: israelDate(snapshot.sourceAsOf), value: value.ilsValue });
    provenance.add(`snapshot:${snapshot.source}`);
    if (value.metadata.qualityFlags.includes("incomplete_fx")) valuationIncomplete = true;
  }
  // FX basis note: external flows are converted to ILS at each flow's own
  // trade-date BoI rate (see externalFlows), while the snapshot valuations use
  // their own snapshot-date FX. Subtracting a flow-date-converted amount from a
  // snapshot-date-converted value means the ILS TWR/MWR includes some FX drift
  // alongside the price return. This is inherent to an ILS-basis return over a
  // multi-currency account; the metric's `basis` label ("..._ils") flags it.
  const flows = await externalFlows(tx, input);
  flows.provenance.forEach((value) => provenance.add(value));
  const twrRate = calculateTimeWeightedReturn(valuations, flows.ils);
  const datedFlows = valuations.length
    ? [
        { date: valuations[0].date, amount: new Decimal(valuations[0].value).neg().toFixed() },
        ...flows.ils.map((flow) => ({
          date: flow.date,
          amount: new Decimal(flow.amount).neg().toFixed(),
        })),
        { date: valuations.at(-1)!.date, amount: valuations.at(-1)!.value },
      ]
    : [];
  const mwrRate = calculateMoneyWeightedReturn(datedFlows);
  const valuationAsOf = selected.at(-1)?.sourceAsOf.toISOString() ?? null;
  const twrQuality = await metricQuality(
    tx,
    input,
    "twr",
    provenance,
    valuationAsOf,
    flows.fxDates,
    flows.incomplete || valuationIncomplete || twrRate === null,
  );
  const mwrQuality = await metricQuality(
    tx,
    input,
    "mwr",
    provenance,
    valuationAsOf,
    flows.fxDates,
    flows.incomplete || valuationIncomplete || mwrRate === null,
  );
  return {
    twr: { rate: twrRate, basis: "time_weighted_return_ils", quality: twrQuality },
    mwr: { rate: mwrRate, basis: "money_weighted_return_ils_irr", quality: mwrQuality },
  };
}

async function dividendIncome(tx: Tx, input: RequiredInput): Promise<InvestmentDividendIncome> {
  let rows = await tx
    .select()
    .from(investmentActivityEvidence)
    .where(
      and(
        eq(investmentActivityEvidence.accountId, input.accountId),
        eq(investmentActivityEvidence.activityType, "dividend"),
        gte(investmentActivityEvidence.tradeDate, input.startDate ?? "0001-01-01"),
        lte(investmentActivityEvidence.tradeDate, input.endDate ?? "9999-12-31"),
      ),
    );
  if (input.instrumentId) rows = rows.filter((row) => row.instrumentId === input.instrumentId);
  const native = new Map<string, Decimal>();
  const provenance = new Set<string>();
  const fxDates: string[] = [];
  let ils = new Decimal(0);
  let incomplete = false;
  let count = 0;
  for (const row of rows) {
    const amountText = decText(
      input.dataKey,
      row.netCashAmountCt,
      row.id,
      "net_cash_amount_ct",
      row.version,
    );
    if (!amountText || !row.currency) {
      incomplete = true;
      continue;
    }
    const amount = new Decimal(amountText);
    native.set(row.currency, (native.get(row.currency) ?? new Decimal(0)).plus(amount));
    const rate = await usableIlsRate(tx, row.currency, row.tradeDate);
    if (rate) {
      ils = ils.plus(amount.mul(rate.rate));
      fxDates.push(rate.date);
    } else incomplete = true;
    provenance.add(row.provenance);
    count += 1;
  }
  return {
    ils: { amount: ils.toFixed(), currency: "ILS", basis: "booked_cash_income" },
    native: nativeFigures(native, "booked_cash_income"),
    bookedCashCount: count,
    quality: await metricQuality(
      tx,
      input,
      "dividends",
      provenance,
      rows
        .map((row) => row.tradeDate)
        .sort()
        .at(-1) ?? null,
      fxDates,
      incomplete,
    ),
  };
}

function required(input: InvestmentReturnsInput): RequiredInput {
  return {
    ...input,
    policyVersion: input.policyVersion ?? BROKER_ELSE_USER_POLICY_VERSION,
    now: input.now ?? new Date(),
  };
}

export function readInvestmentRealizedGain(
  input: InvestmentReturnsInput,
): Promise<InvestmentRealizedGain> {
  const held = required(input);
  return withUser(input.userId, (tx) => realizedGain(tx, held));
}

export function readInvestmentUnrealizedGain(
  input: InvestmentReturnsInput,
): Promise<InvestmentUnrealizedGain> {
  const held = required(input);
  return withUser(input.userId, (tx) => unrealizedGain(tx, held));
}

export function readInvestmentPerformance(
  input: InvestmentReturnsInput,
): Promise<InvestmentPerformance> {
  const held = required(input);
  return withUser(input.userId, (tx) => performance(tx, held));
}

export function readInvestmentDividendIncome(
  input: InvestmentReturnsInput,
): Promise<InvestmentDividendIncome> {
  const held = required(input);
  return withUser(input.userId, (tx) => dividendIncome(tx, held));
}

export function readInvestmentReturns(
  input: InvestmentReturnsInput,
): Promise<InvestmentReturnsRead> {
  const held = required(input);
  return withUser(input.userId, async (tx) => ({
    realizedGain: await realizedGain(tx, held),
    unrealizedGain: await unrealizedGain(tx, held),
    performance: await performance(tx, held),
    dividendIncome: await dividendIncome(tx, held),
  }));
}
