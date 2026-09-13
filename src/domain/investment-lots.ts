import { createHmac, randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import Decimal from "decimal.js";

import { withUser, type UserTransaction } from "@/db/client";
import {
  accounts,
  connections,
  investmentActivityCoverage,
  investmentActivityEvidence,
  investmentCorporateActionEvidence,
  investmentDisposalResolutionQueue,
  investmentLotClosures,
  investmentOpeningLotEvidence,
  investmentTaxLots,
} from "@/db/schema";
import type { BrokerLotAllocation } from "@/lib/investments";
import { decText, encText } from "./fields";
import { lockAcquisitionFx } from "./investment-fx";

type Tx = UserTransaction;
type Completeness = "complete" | "partial" | "unknown";
type CoverageBasis = "provider_declared" | "earliest_observed" | null;
type FxProvenance = "boi_derived" | "user_entered" | "unresolved";

export const BROKER_ELSE_USER_POLICY_VERSION = "broker-else-user-v1";

export interface InvestmentTaxLotDerivationInput {
  userId: string;
  accountId: string;
  instrumentId: string;
  policyVersion?: string;
  /** Tier-1 data key. The caller owns its lifetime and wiping. */
  dataKey: Uint8Array;
}

export interface InvestmentTaxLotDerivationResult {
  policyVersion: string;
  lots: number;
  closures: number;
  unresolvedDisposals: number;
  completeness: Completeness;
  coverageStart: string | null;
  coverageBasis: CoverageBasis;
}

interface PlainLot {
  id: string;
  current: typeof investmentTaxLots.$inferSelect | null;
  derivationKey: Buffer;
  acquisitionActivityId: string | null;
  openingLotEvidenceId: string | null;
  tradeDate: string;
  settlementDate: string | null;
  originalQuantity: string;
  remainingQuantity: string;
  quantityUnit: string;
  costBasis: string;
  costBasisCurrency: string;
  lockedFxRate: string | null;
  lockedFxConvention: string | null;
  lockedFxObservationDate: string | null;
  lockedFxProvenance: FxProvenance;
  aliases: string[];
}

interface PlainClosure {
  current: typeof investmentLotClosures.$inferSelect | null;
  sellActivityEvidenceId: string;
  lot: PlainLot;
  closedQuantity: string;
  proceeds: string;
  realizedCostBasis: string;
  lockedFxRate: string | null;
  lockedFxConvention: string;
  lockedFxObservationDate: string | null;
  lockedFxProvenance: FxProvenance;
  allocationProvenance: "broker_reported" | "user_selected";
}

interface UserDisposalAllocation {
  type: "disposal_allocation";
  allocations: Array<{ lotId: string; quantity: string }>;
}

function decimal(value: string): Decimal {
  return new Decimal(value);
}

function absolute(value: string): Decimal {
  return decimal(value).abs();
}

function derivedKey(dataKey: Uint8Array, kind: "activity" | "opening", id: string): Buffer {
  return createHmac("sha256", dataKey)
    .update("investment-tax-lot\0")
    .update(kind)
    .update("\0")
    .update(id)
    .digest();
}

function text(
  dataKey: Uint8Array,
  row: { id: string; version: number },
  value: Buffer | null,
  column: string,
): string | null {
  return decText(dataKey, value, row.id, column, row.version);
}

function parseAllocations(value: string | null): BrokerLotAllocation[] | null {
  if (value === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const allocations: BrokerLotAllocation[] = [];
  const seen = new Set<string>();
  for (const held of parsed) {
    if (
      typeof held !== "object" ||
      held === null ||
      !("sourceLotId" in held) ||
      !("quantity" in held) ||
      typeof held.sourceLotId !== "string" ||
      held.sourceLotId.length === 0 ||
      typeof held.quantity !== "string" ||
      seen.has(held.sourceLotId)
    ) {
      return null;
    }
    try {
      if (!decimal(held.quantity).isPositive()) return null;
    } catch {
      return null;
    }
    seen.add(held.sourceLotId);
    allocations.push({
      sourceLotId: held.sourceLotId,
      quantity: decimal(held.quantity).toString(),
    });
  }
  return allocations;
}

function activityAliases(
  dataKey: Uint8Array,
  row: typeof investmentActivityEvidence.$inferSelect,
): string[] {
  return [
    text(dataKey, row, row.providerActivityIdCt, "provider_activity_id_ct"),
    text(dataKey, row, row.providerExecutionIdCt, "provider_execution_id_ct"),
    text(dataKey, row, row.providerTradeIdCt, "provider_trade_id_ct"),
    text(dataKey, row, row.brokerOpenDateTimeCt, "broker_open_date_time_ct"),
  ].filter((value): value is string => value !== null);
}

function lotMatches(
  dataKey: Uint8Array,
  current: typeof investmentTaxLots.$inferSelect,
  desired: PlainLot,
  completeness: Completeness,
): boolean {
  return (
    current.acquisitionActivityId === desired.acquisitionActivityId &&
    current.openingLotEvidenceId === desired.openingLotEvidenceId &&
    current.tradeDate === desired.tradeDate &&
    current.settlementDate === desired.settlementDate &&
    text(dataKey, current, current.originalQuantityCt, "original_quantity_ct") ===
      desired.originalQuantity &&
    text(dataKey, current, current.remainingQuantityCt, "remaining_quantity_ct") ===
      desired.remainingQuantity &&
    current.quantityUnit === desired.quantityUnit &&
    text(dataKey, current, current.costBasisCt, "cost_basis_ct") === desired.costBasis &&
    current.costBasisCurrency === desired.costBasisCurrency &&
    text(dataKey, current, current.lockedFxRateCt, "locked_fx_rate_ct") === desired.lockedFxRate &&
    current.lockedFxConvention === desired.lockedFxConvention &&
    current.lockedFxObservationDate === desired.lockedFxObservationDate &&
    current.lockedFxProvenance === desired.lockedFxProvenance &&
    current.completeness === completeness
  );
}

async function storeLot(
  tx: Tx,
  input: Required<InvestmentTaxLotDerivationInput>,
  lot: PlainLot,
  completeness: Completeness,
): Promise<void> {
  const version = lot.current ? lot.current.version + 1 : 1;
  const values = {
    ownerId: input.userId,
    accountId: input.accountId,
    instrumentId: input.instrumentId,
    acquisitionActivityId: lot.acquisitionActivityId,
    openingLotEvidenceId: lot.openingLotEvidenceId,
    derivationKey: lot.derivationKey,
    policyVersion: input.policyVersion,
    tradeDate: lot.tradeDate,
    settlementDate: lot.settlementDate,
    originalQuantityCt: encText(
      input.dataKey,
      lot.originalQuantity,
      lot.id,
      "original_quantity_ct",
      version,
    ),
    remainingQuantityCt: encText(
      input.dataKey,
      lot.remainingQuantity,
      lot.id,
      "remaining_quantity_ct",
      version,
    ),
    quantityUnit: lot.quantityUnit,
    costBasisCt: encText(input.dataKey, lot.costBasis, lot.id, "cost_basis_ct", version),
    costBasisCurrency: lot.costBasisCurrency,
    lockedFxRateCt: lot.lockedFxRate
      ? encText(input.dataKey, lot.lockedFxRate, lot.id, "locked_fx_rate_ct", version)
      : null,
    lockedFxConvention: lot.lockedFxConvention,
    lockedFxObservationDate: lot.lockedFxObservationDate,
    lockedFxProvenance: lot.lockedFxProvenance,
    completeness,
    version,
  };
  if (!lot.current) {
    await tx.insert(investmentTaxLots).values({ id: lot.id, ...values });
  } else if (!lotMatches(input.dataKey, lot.current, lot, completeness)) {
    await tx.update(investmentTaxLots).set(values).where(eq(investmentTaxLots.id, lot.id));
  }
}

function closureMatches(
  dataKey: Uint8Array,
  row: typeof investmentLotClosures.$inferSelect,
  desired: PlainClosure,
): boolean {
  return (
    text(dataKey, row, row.closedQuantityCt, "closed_quantity_ct") === desired.closedQuantity &&
    text(dataKey, row, row.proceedsCt, "proceeds_ct") === desired.proceeds &&
    text(dataKey, row, row.realizedCostBasisCt, "realized_cost_basis_ct") ===
      desired.realizedCostBasis &&
    text(dataKey, row, row.lockedFxRateCt, "locked_fx_rate_ct") === desired.lockedFxRate &&
    row.lockedFxConvention === desired.lockedFxConvention &&
    row.lockedFxObservationDate === desired.lockedFxObservationDate &&
    row.lockedFxProvenance === desired.lockedFxProvenance &&
    row.allocationProvenance === desired.allocationProvenance
  );
}

async function storeClosure(
  tx: Tx,
  input: Required<InvestmentTaxLotDerivationInput>,
  closure: PlainClosure,
): Promise<void> {
  if (closure.current && closureMatches(input.dataKey, closure.current, closure)) return;
  const id = closure.current?.id ?? randomUUID();
  const version = closure.current ? closure.current.version + 1 : 1;
  const values = {
    ownerId: input.userId,
    sellActivityEvidenceId: closure.sellActivityEvidenceId,
    closedTaxLotId: closure.lot.id,
    closedQuantityCt: encText(
      input.dataKey,
      closure.closedQuantity,
      id,
      "closed_quantity_ct",
      version,
    ),
    proceedsCt: encText(input.dataKey, closure.proceeds, id, "proceeds_ct", version),
    realizedCostBasisCt: encText(
      input.dataKey,
      closure.realizedCostBasis,
      id,
      "realized_cost_basis_ct",
      version,
    ),
    lockedFxRateCt: closure.lockedFxRate
      ? encText(input.dataKey, closure.lockedFxRate, id, "locked_fx_rate_ct", version)
      : null,
    lockedFxConvention: closure.lockedFxConvention,
    lockedFxObservationDate: closure.lockedFxObservationDate,
    lockedFxProvenance: closure.lockedFxProvenance,
    allocationProvenance: closure.allocationProvenance,
    version,
  };
  if (closure.current) {
    await tx.update(investmentLotClosures).set(values).where(eq(investmentLotClosures.id, id));
  } else {
    await tx.insert(investmentLotClosures).values({ id, ...values });
  }
}

export async function deriveInvestmentTaxLotsInTransaction(
  tx: Tx,
  input: Required<InvestmentTaxLotDerivationInput>,
): Promise<InvestmentTaxLotDerivationResult> {
  const activities = await tx
    .select()
    .from(investmentActivityEvidence)
    .where(
      and(
        eq(investmentActivityEvidence.accountId, input.accountId),
        eq(investmentActivityEvidence.instrumentId, input.instrumentId),
      ),
    )
    .orderBy(asc(investmentActivityEvidence.tradeDate), asc(investmentActivityEvidence.id));
  const openings = await tx
    .select()
    .from(investmentOpeningLotEvidence)
    .where(
      and(
        eq(investmentOpeningLotEvidence.accountId, input.accountId),
        eq(investmentOpeningLotEvidence.instrumentId, input.instrumentId),
      ),
    )
    .orderBy(asc(investmentOpeningLotEvidence.tradeDate), asc(investmentOpeningLotEvidence.id));
  const corporateActions = await tx
    .select()
    .from(investmentCorporateActionEvidence)
    .where(
      and(
        eq(investmentCorporateActionEvidence.accountId, input.accountId),
        eq(investmentCorporateActionEvidence.instrumentId, input.instrumentId),
      ),
    )
    .orderBy(
      asc(investmentCorporateActionEvidence.actionDate),
      asc(investmentCorporateActionEvidence.id),
    );
  const existingLots = await tx
    .select()
    .from(investmentTaxLots)
    .where(
      and(
        eq(investmentTaxLots.accountId, input.accountId),
        eq(investmentTaxLots.instrumentId, input.instrumentId),
        eq(investmentTaxLots.policyVersion, input.policyVersion),
      ),
    );
  const [coverage] = await tx
    .select()
    .from(investmentActivityCoverage)
    .where(
      and(
        eq(investmentActivityCoverage.accountId, input.accountId),
        eq(investmentActivityCoverage.instrumentId, input.instrumentId),
        eq(investmentActivityCoverage.metric, "cost_basis"),
      ),
    )
    .limit(1);
  const [account] = await tx
    .select({ connectorId: connections.connectorId })
    .from(accounts)
    .innerJoin(connections, eq(accounts.connectionId, connections.id))
    .where(eq(accounts.id, input.accountId))
    .limit(1);

  const currentByKey = new Map(
    existingLots.map((lot) => [Buffer.from(lot.derivationKey).toString("hex"), lot]),
  );
  const lots: PlainLot[] = [];
  let coverageGap = false;

  for (const row of openings) {
    const key = derivedKey(input.dataKey, "opening", row.id);
    const current = currentByKey.get(key.toString("hex")) ?? null;
    const originalQuantity = text(
      input.dataKey,
      row,
      row.originalQuantityCt,
      "original_quantity_ct",
    )!;
    const remainingQuantity = text(
      input.dataKey,
      row,
      row.remainingQuantityCt,
      "remaining_quantity_ct",
    )!;
    const costBasis = text(input.dataKey, row, row.totalCostCt, "total_cost_ct")!;
    const brokerLotId = text(input.dataKey, row, row.brokerLotIdCt, "broker_lot_id_ct");
    lots.push({
      id: current?.id ?? randomUUID(),
      current,
      derivationKey: key,
      acquisitionActivityId: null,
      openingLotEvidenceId: row.id,
      tradeDate: row.tradeDate,
      settlementDate: row.settlementDate,
      originalQuantity: decimal(originalQuantity).abs().toString(),
      remainingQuantity: decimal(remainingQuantity).abs().toString(),
      quantityUnit: row.quantityUnit,
      costBasis: decimal(costBasis).abs().toString(),
      costBasisCurrency: row.currency,
      lockedFxRate: text(input.dataKey, row, row.lockedFxRateCt, "locked_fx_rate_ct"),
      lockedFxConvention: row.lockedFxConvention,
      lockedFxObservationDate: row.lockedFxObservationDate,
      lockedFxProvenance: row.lockedFxProvenance,
      aliases: brokerLotId ? [brokerLotId] : [],
    });
  }

  for (const row of activities.filter((activity) => activity.activityType === "buy")) {
    const quantity = text(input.dataKey, row, row.quantityCt, "quantity_ct");
    const gross = text(input.dataKey, row, row.grossAmountCt, "gross_amount_ct");
    const price = text(input.dataKey, row, row.priceCt, "price_ct");
    if (!quantity || !row.quantityUnit || !row.currency || (!gross && !price)) {
      coverageGap = true;
      continue;
    }
    const heldQuantity = absolute(quantity);
    if (!heldQuantity.isPositive()) {
      coverageGap = true;
      continue;
    }
    const fee = text(input.dataKey, row, row.feeAmountCt, "fee_amount_ct");
    const basis = (gross ? absolute(gross) : absolute(price!).mul(heldQuantity)).plus(
      fee ? absolute(fee) : new Decimal("0"),
    );
    const key = derivedKey(input.dataKey, "activity", row.id);
    const current = currentByKey.get(key.toString("hex")) ?? null;
    // ADR 0014: acquisition FX is locked historical evidence. Reuse the rate a
    // prior derivation already locked and only (re)lock when it was never
    // resolved, so a BoI observation published after the first run cannot
    // rewrite an existing lot (openings persist their rate the same way).
    const fx =
      current && current.lockedFxProvenance !== "unresolved"
        ? {
            rateString: text(input.dataKey, current, current.lockedFxRateCt, "locked_fx_rate_ct"),
            convention: current.lockedFxConvention,
            observationDate: current.lockedFxObservationDate,
            provenance: current.lockedFxProvenance,
          }
        : await lockAcquisitionFx(tx, {
            tradeDate: row.tradeDate,
            settlementDate: row.settlementDate ?? undefined,
            fromCurrency: row.currency,
            toCurrency: "ILS",
          });
    lots.push({
      id: current?.id ?? randomUUID(),
      current,
      derivationKey: key,
      acquisitionActivityId: row.id,
      openingLotEvidenceId: null,
      tradeDate: row.tradeDate,
      settlementDate: row.settlementDate,
      originalQuantity: heldQuantity.toString(),
      remainingQuantity: heldQuantity.toString(),
      quantityUnit: row.quantityUnit,
      costBasis: basis.toString(),
      costBasisCurrency: row.currency,
      lockedFxRate: fx.rateString,
      lockedFxConvention: fx.rateString ? fx.convention : null,
      lockedFxObservationDate: fx.observationDate,
      lockedFxProvenance: fx.provenance,
      aliases: activityAliases(input.dataKey, row),
    });
  }

  const aliases = new Map<string, PlainLot | null>();
  for (const lot of lots) {
    for (const alias of lot.aliases) aliases.set(alias, aliases.has(alias) ? null : lot);
  }

  const existingClosures = existingLots.length
    ? await tx
        .select()
        .from(investmentLotClosures)
        .where(
          inArray(
            investmentLotClosures.closedTaxLotId,
            existingLots.map((lot) => lot.id),
          ),
        )
    : [];
  const closureByPair = new Map(
    existingClosures.map((closure) => [
      `${closure.sellActivityEvidenceId}:${closure.closedTaxLotId}`,
      closure,
    ]),
  );
  const disposalResolutions = await tx
    .select()
    .from(investmentDisposalResolutionQueue)
    .where(
      and(
        eq(investmentDisposalResolutionQueue.accountId, input.accountId),
        eq(investmentDisposalResolutionQueue.kind, "unresolved_disposal"),
        eq(investmentDisposalResolutionQueue.policyVersion, input.policyVersion),
      ),
    );
  const userAllocations = new Map<string, UserDisposalAllocation["allocations"]>();
  for (const row of disposalResolutions) {
    if (row.status !== "resolved" || !row.activityEvidenceId || !row.detailsCt) continue;
    try {
      const parsed = JSON.parse(
        text(input.dataKey, row, row.detailsCt, "details_ct") ?? "",
      ) as UserDisposalAllocation;
      if (
        parsed.type === "disposal_allocation" &&
        Array.isArray(parsed.allocations) &&
        parsed.allocations.length > 0
      ) {
        userAllocations.set(row.activityEvidenceId, parsed.allocations);
      }
    } catch {
      // Pending rows and older rows contain a plain evidence sentence.
    }
  }
  const closures: PlainClosure[] = [];
  const unresolvedSales: (typeof investmentActivityEvidence.$inferSelect)[] = [];

  for (const sale of activities.filter((activity) => activity.activityType === "sell")) {
    const brokerAllocations = parseAllocations(
      text(input.dataKey, sale, sale.brokerLotAllocationsCt, "broker_lot_allocations_ct"),
    );
    const saleQuantityText = text(input.dataKey, sale, sale.quantityCt, "quantity_ct");
    const gross = text(input.dataKey, sale, sale.grossAmountCt, "gross_amount_ct");
    const price = text(input.dataKey, sale, sale.priceCt, "price_ct");
    const saleQuantity = saleQuantityText ? absolute(saleQuantityText) : null;
    const candidates = [
      brokerAllocations && {
        provenance: "broker_reported" as const,
        targets: brokerAllocations.map((allocation) => ({
          quantity: allocation.quantity,
          lot: aliases.get(allocation.sourceLotId) ?? null,
        })),
      },
      userAllocations.get(sale.id) && {
        provenance: "user_selected" as const,
        targets: userAllocations.get(sale.id)!.map((allocation) => ({
          quantity: allocation.quantity,
          lot: lots.find((lot) => lot.id === allocation.lotId) ?? null,
        })),
      },
    ].filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
    const selected = candidates.find((candidate) => {
      try {
        const total = candidate.targets.reduce(
          (sum, allocation) => sum.plus(allocation.quantity),
          new Decimal("0"),
        );
        return (
          saleQuantity !== null &&
          saleQuantity.isPositive() &&
          total.equals(saleQuantity) &&
          sale.currency !== null &&
          (gross !== null || price !== null) &&
          candidate.targets.every(
            ({ quantity, lot }) =>
              lot !== null &&
              lot.tradeDate <= sale.tradeDate &&
              (!sale.quantityUnit || lot.quantityUnit === sale.quantityUnit) &&
              decimal(quantity).isPositive() &&
              decimal(lot.remainingQuantity).gte(quantity),
          )
        );
      } catch {
        return false;
      }
    });
    if (!selected) {
      unresolvedSales.push(sale);
      continue;
    }
    const heldSaleQuantity = saleQuantity!;

    // Net the disposal's own commission (and any sale tax) out of proceeds so
    // realized gain subtracts both legs symmetrically with the buy side, which
    // folds the acquisition fee into cost basis.
    const disposalFee = text(input.dataKey, sale, sale.feeAmountCt, "fee_amount_ct");
    const disposalTax = text(input.dataKey, sale, sale.taxAmountCt, "tax_amount_ct");
    const saleProceeds = (gross ? absolute(gross) : absolute(price!).mul(heldSaleQuantity))
      .minus(disposalFee ? absolute(disposalFee) : new Decimal("0"))
      .minus(disposalTax ? absolute(disposalTax) : new Decimal("0"));
    const saleFx = await lockAcquisitionFx(tx, {
      tradeDate: sale.tradeDate,
      settlementDate: sale.settlementDate ?? undefined,
      fromCurrency: sale.currency!,
      toCurrency: "ILS",
    });
    const saleTargets = selected.targets;
    let allocatedProceeds = new Decimal("0");
    for (let index = 0; index < saleTargets.length; index += 1) {
      const { quantity, lot } = saleTargets[index];
      const heldLot = lot!;
      const closedQuantity = decimal(quantity);
      // Allocate the final lot as (total − sum of previous) so per-lot proceeds
      // reconcile exactly to the recorded sale total instead of drifting by a
      // rounding unit across the split.
      const proceeds =
        index === saleTargets.length - 1
          ? saleProceeds.minus(allocatedProceeds)
          : saleProceeds.mul(closedQuantity).div(heldSaleQuantity);
      allocatedProceeds = allocatedProceeds.plus(proceeds);
      const existingClosure = closureByPair.get(`${sale.id}:${heldLot.id}`) ?? null;
      // The disposal FX is locked historical evidence too (ADR 0014): reuse the
      // rate a prior derivation locked and only (re)lock when unresolved.
      const closureFx =
        existingClosure && existingClosure.lockedFxProvenance !== "unresolved"
          ? {
              rateString: text(
                input.dataKey,
                existingClosure,
                existingClosure.lockedFxRateCt,
                "locked_fx_rate_ct",
              ),
              convention: existingClosure.lockedFxConvention,
              observationDate: existingClosure.lockedFxObservationDate,
              provenance: existingClosure.lockedFxProvenance,
            }
          : saleFx;
      closures.push({
        current: existingClosure,
        sellActivityEvidenceId: sale.id,
        lot: heldLot,
        closedQuantity: closedQuantity.toString(),
        proceeds: proceeds.toString(),
        realizedCostBasis: decimal(heldLot.costBasis)
          .mul(closedQuantity)
          .div(heldLot.originalQuantity)
          .toString(),
        lockedFxRate: closureFx.rateString,
        lockedFxConvention: closureFx.convention,
        lockedFxObservationDate: closureFx.observationDate,
        lockedFxProvenance: closureFx.provenance,
        allocationProvenance: selected.provenance,
      });
      heldLot.remainingQuantity = decimal(heldLot.remainingQuantity)
        .minus(closedQuantity)
        .toString();
    }
  }

  const evidenceDates = [
    ...activities
      .filter((row) => row.activityType === "buy" || row.activityType === "sell")
      .map((row) => row.tradeDate),
    ...openings.map((row) => row.tradeDate),
    ...corporateActions.map((row) => row.actionDate),
  ].sort();
  const hasEvidence = evidenceDates.length > 0;
  const completeness: Completeness = !hasEvidence
    ? "unknown"
    : coverageGap || unresolvedSales.length > 0 || corporateActions.length > 0
      ? "partial"
      : "complete";
  const coverageStart =
    coverage?.coverageBasis === "provider_declared"
      ? coverage.coverageStart
      : (evidenceDates[0] ?? null);
  const coverageBasis: CoverageBasis =
    coverage?.coverageBasis === "provider_declared"
      ? "provider_declared"
      : coverageStart
        ? "earliest_observed"
        : null;

  for (const lot of lots) await storeLot(tx, input, lot, completeness);

  const desiredClosurePairs = new Set(
    closures.map((closure) => `${closure.sellActivityEvidenceId}:${closure.lot.id}`),
  );
  const existingLotIds = new Set(existingLots.map((lot) => lot.id));
  for (const closure of existingClosures) {
    if (
      existingLotIds.has(closure.closedTaxLotId) &&
      !desiredClosurePairs.has(`${closure.sellActivityEvidenceId}:${closure.closedTaxLotId}`)
    ) {
      await tx.delete(investmentLotClosures).where(eq(investmentLotClosures.id, closure.id));
    }
  }
  for (const closure of closures) await storeClosure(tx, input, closure);
  const desiredLotIds = new Set(lots.map((lot) => lot.id));
  for (const lot of existingLots) {
    if (!desiredLotIds.has(lot.id)) {
      await tx.delete(investmentTaxLots).where(eq(investmentTaxLots.id, lot.id));
    }
  }

  const activityIds = new Set(activities.map((activity) => activity.id));
  const queued = (
    await tx
      .select()
      .from(investmentDisposalResolutionQueue)
      .where(
        and(
          eq(investmentDisposalResolutionQueue.accountId, input.accountId),
          eq(investmentDisposalResolutionQueue.kind, "unresolved_disposal"),
          eq(investmentDisposalResolutionQueue.policyVersion, input.policyVersion),
        ),
      )
  ).filter((row) => row.activityEvidenceId && activityIds.has(row.activityEvidenceId));
  const unresolvedIds = new Set(unresolvedSales.map((sale) => sale.id));
  for (const row of queued) {
    if (row.status === "pending" && !unresolvedIds.has(row.activityEvidenceId!)) {
      await tx
        .delete(investmentDisposalResolutionQueue)
        .where(eq(investmentDisposalResolutionQueue.id, row.id));
    }
  }
  for (const sale of unresolvedSales) {
    if (queued.some((row) => row.activityEvidenceId === sale.id)) continue;
    const id = randomUUID();
    await tx.insert(investmentDisposalResolutionQueue).values({
      id,
      ownerId: input.userId,
      accountId: input.accountId,
      activityEvidenceId: sale.id,
      kind: "unresolved_disposal",
      detailsCt: encText(
        input.dataKey,
        "No complete, unambiguous broker-reported lot allocation was supplied.",
        id,
        "details_ct",
        1,
      ),
      policyVersion: input.policyVersion,
    });
  }

  const accountSource =
    account?.connectorId === "ibkr_flex" ||
    account?.connectorId === "snaptrade" ||
    account?.connectorId === "schwab_positions_csv"
      ? account.connectorId
      : null;
  const source =
    activities[0]?.source ?? corporateActions[0]?.source ?? coverage?.source ?? accountSource;
  if (!source) throw new Error("investment account has no supported evidence source");
  const coverageValues = {
    source,
    coverageStart,
    coverageBasis,
    completeness,
  };
  if (!coverage) {
    await tx.insert(investmentActivityCoverage).values({
      ownerId: input.userId,
      accountId: input.accountId,
      instrumentId: input.instrumentId,
      metric: "cost_basis",
      ...coverageValues,
    });
  } else if (
    coverage.source !== source ||
    coverage.coverageStart !== coverageStart ||
    coverage.coverageBasis !== coverageBasis ||
    coverage.completeness !== completeness
  ) {
    await tx
      .update(investmentActivityCoverage)
      .set(coverageValues)
      .where(eq(investmentActivityCoverage.id, coverage.id));
  }

  return {
    policyVersion: input.policyVersion,
    lots: lots.length,
    closures: closures.length,
    unresolvedDisposals: unresolvedSales.length,
    completeness,
    coverageStart,
    coverageBasis,
  };
}

/** Replays one owner/account/instrument scope under one named lot policy. */
export function deriveInvestmentTaxLots(
  input: InvestmentTaxLotDerivationInput,
): Promise<InvestmentTaxLotDerivationResult> {
  const required = {
    ...input,
    policyVersion: input.policyVersion ?? BROKER_ELSE_USER_POLICY_VERSION,
  };
  return withUser(input.userId, (tx) => deriveInvestmentTaxLotsInTransaction(tx, required));
}
