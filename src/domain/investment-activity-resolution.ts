import Decimal from "decimal.js";
import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";

import { withUser, type UserTransaction } from "@/db/client";
import {
  accounts,
  instruments,
  instrumentSourceMappings,
  investmentActivityCoverage,
  investmentActivityEvidence,
  investmentDisposalResolutionQueue,
  investmentLotClosures,
  investmentOpeningLotEvidence,
  investmentReconciliationQuality,
  investmentTaxLots,
} from "@/db/schema";
import type { Session } from "@/lib/auth/session-store";
import { decText, encText } from "./fields";
import { lockAcquisitionFx } from "./investment-fx";
import { currentReconciliationSnapshot } from "./investment-valuation";
import {
  deriveInvestmentTaxLotsInTransaction,
  type InvestmentTaxLotDerivationResult,
} from "./investment-lots";

type Tx = UserTransaction;
export type InvestmentResolutionKind =
  "unresolved_disposal" | "identity_ambiguity" | "reconciliation_gap";

export class InvestmentResolutionError extends Error {
  constructor(
    readonly code: "not_found" | "already_resolved" | "unsupported_kind" | "invalid_allocation",
  ) {
    super(code);
    this.name = "InvestmentResolutionError";
  }
}

export interface EligibleLotView {
  id: string;
  acquisitionDate: string;
  remainingQuantity: string;
  originalQuantity: string;
  nativeCostBasis: string;
  currency: string;
  lockedFxRate: string | null;
  lockedFxState: "Bank of Israel" | "User entered" | "Unavailable";
  lockedFxDate: string | null;
  completeness: "complete" | "partial" | "unknown";
}

export interface InvestmentResolutionItemView {
  id: string;
  kind: InvestmentResolutionKind;
  kindLabel: "Sale" | "Identity" | "History gap";
  status: "pending" | "resolved";
  accountId: string;
  accountName: string;
  instrumentId: string | null;
  instrumentLabel: string;
  eventDate: string | null;
  eventDateLabel: string | null;
  consequence: string;
  affectedMetrics: string[];
  retainedDetails: string | null;
  resolvedAtLabel: string | null;
  sale: null | {
    quantity: string;
    quantityUnit: string;
    proceeds: string;
    currency: string;
    source: string;
    description: string | null;
    eligibleLots: EligibleLotView[];
    resolvedAllocations: Array<{
      lotId: string;
      quantity: string;
      acquisitionDate: string | null;
      nativeRealizedCostBasis: string | null;
      nativeProceeds: string | null;
    }>;
  };
  identity: null | {
    source: string;
    description: string | null;
    amount: string | null;
    currency: string | null;
    durableIdentifiers: Array<{ label: string; value: string }>;
    limitation: string;
  };
  gap: null | {
    dimensionLabel: string;
    expected: string | null;
    observed: string | null;
    currency: string | null;
    openingQuantity: string | null;
    canAddOpeningLot: boolean;
  };
}

export interface OpeningLotsAccountView {
  accountId: string;
  accountName: string;
  lotCount: number;
  completeness: "complete" | "partial" | "unknown";
  lastImportLabel: string | null;
}

export interface InvestmentActivityView {
  pending: InvestmentResolutionItemView[];
  recentlyResolved: InvestmentResolutionItemView[];
  pendingCount: number;
  counts: { sales: number; identity: number; historyGaps: number };
  openingLots: OpeningLotsAccountView[];
}

export interface DisposalAllocationInput {
  lotId: string;
  quantity: string;
}

export interface DisposalResolutionPreview {
  queueId: string;
  saleQuantity: string;
  allocatedQuantity: string;
  currency: string;
  nativeProceeds: string;
  nativeRealizedCostBasis: string;
  ilsGainIncludesFx: string | null;
  completeness: "complete" | "partial";
  allocations: Array<{
    lotId: string;
    acquisitionDate: string;
    quantity: string;
    nativeRealizedCostBasis: string;
  }>;
}

function text(
  dataKey: Uint8Array,
  row: { id: string; version: number },
  value: Buffer | null,
  column: string,
): string | null {
  return decText(dataKey, value, row.id, column, row.version);
}

function dateLabel(value: string | Date | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(`${value}T00:00:00Z`);
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeZone: "Asia/Jerusalem",
  }).format(date);
}

function sourceLabel(source: string): string {
  if (source === "ibkr_flex") return "Interactive Brokers Flex";
  if (source === "schwab_positions_csv") return "Schwab statement";
  if (source === "snaptrade") return "Broker connection";
  return source;
}

function instrumentLabel(
  dataKey: Uint8Array,
  row: typeof instruments.$inferSelect | undefined,
): string {
  if (!row) return "Account-wide evidence";
  return (
    text(dataKey, row, row.canonicalSymbolCt, "canonical_symbol_ct") ??
    text(dataKey, row, row.canonicalNameCt, "canonical_name_ct") ??
    "Unnamed investment"
  );
}

function kindPresentation(kind: InvestmentResolutionKind): {
  label: InvestmentResolutionItemView["kindLabel"];
  consequence: string;
  metrics: string[];
} {
  if (kind === "unresolved_disposal")
    return {
      label: "Sale",
      consequence:
        "Realized gain and remaining lot quantities stay partial until this sale is allocated.",
      metrics: ["Realized gain", "Cost basis", "Returns"],
    };
  if (kind === "identity_ambiguity")
    return {
      label: "Identity",
      consequence:
        "This activity is excluded until its conflicting source identity can be verified.",
      metrics: ["Cash income", "Returns"],
    };
  return {
    label: "History gap",
    consequence: "The broker snapshot and activity history do not yet reconcile.",
    metrics: ["Cost basis", "Unrealized gain", "Returns"],
  };
}

interface ReadContext {
  accountById: Map<string, typeof accounts.$inferSelect>;
  activityById: Map<string, typeof investmentActivityEvidence.$inferSelect>;
  qualityById: Map<string, typeof investmentReconciliationQuality.$inferSelect>;
  instrumentById: Map<string, typeof instruments.$inferSelect>;
  mappings: Array<typeof instrumentSourceMappings.$inferSelect>;
  lots: Array<typeof investmentTaxLots.$inferSelect>;
  closures: Array<typeof investmentLotClosures.$inferSelect>;
}

async function readContext(
  tx: Tx,
  rows: Array<typeof investmentDisposalResolutionQueue.$inferSelect>,
): Promise<ReadContext> {
  const accountIds = [...new Set(rows.map((row) => row.accountId))];
  const activityIds = rows.flatMap((row) =>
    row.activityEvidenceId ? [row.activityEvidenceId] : [],
  );
  const qualityIds = rows.flatMap((row) =>
    row.reconciliationQualityId ? [row.reconciliationQualityId] : [],
  );
  const accountRows = accountIds.length
    ? await tx.select().from(accounts).where(inArray(accounts.id, accountIds))
    : [];
  const activityRows = activityIds.length
    ? await tx
        .select()
        .from(investmentActivityEvidence)
        .where(inArray(investmentActivityEvidence.id, activityIds))
    : [];
  const qualityRows = qualityIds.length
    ? await tx
        .select()
        .from(investmentReconciliationQuality)
        .where(inArray(investmentReconciliationQuality.id, qualityIds))
    : [];
  const instrumentIds = [
    ...new Set(
      [
        ...activityRows.map((row) => row.instrumentId),
        ...qualityRows.map((row) => row.instrumentId),
      ].filter((id): id is string => id !== null),
    ),
  ];
  const instrumentRows = instrumentIds.length
    ? await tx.select().from(instruments).where(inArray(instruments.id, instrumentIds))
    : [];
  const mappings = instrumentIds.length
    ? await tx
        .select()
        .from(instrumentSourceMappings)
        .where(inArray(instrumentSourceMappings.instrumentId, instrumentIds))
    : [];
  const lots = accountIds.length
    ? await tx
        .select()
        .from(investmentTaxLots)
        .where(inArray(investmentTaxLots.accountId, accountIds))
        .orderBy(asc(investmentTaxLots.tradeDate))
    : [];
  const closures = await tx.select().from(investmentLotClosures);
  return {
    accountById: new Map(accountRows.map((row) => [row.id, row])),
    activityById: new Map(activityRows.map((row) => [row.id, row])),
    qualityById: new Map(qualityRows.map((row) => [row.id, row])),
    instrumentById: new Map(instrumentRows.map((row) => [row.id, row])),
    mappings,
    lots,
    closures,
  };
}

function parseResolvedAllocations(
  dataKey: Uint8Array,
  row: typeof investmentDisposalResolutionQueue.$inferSelect,
): Array<{ lotId: string; quantity: string }> {
  if (row.status !== "resolved" || !row.detailsCt) return [];
  try {
    const parsed = JSON.parse(text(dataKey, row, row.detailsCt, "details_ct") ?? "") as {
      type?: string;
      allocations?: Array<{ lotId: string; quantity: string }>;
    };
    return parsed.type === "disposal_allocation" && Array.isArray(parsed.allocations)
      ? parsed.allocations
      : [];
  } catch {
    return [];
  }
}

function toItem(
  dataKey: Uint8Array,
  row: typeof investmentDisposalResolutionQueue.$inferSelect,
  context: ReadContext,
): InvestmentResolutionItemView {
  const account = context.accountById.get(row.accountId);
  const activity = row.activityEvidenceId
    ? context.activityById.get(row.activityEvidenceId)
    : undefined;
  const quality = row.reconciliationQualityId
    ? context.qualityById.get(row.reconciliationQualityId)
    : undefined;
  const instrumentId = activity?.instrumentId ?? quality?.instrumentId ?? null;
  const presentation = kindPresentation(row.kind);
  const saleQuantity = activity?.quantityCt
    ? new Decimal(text(dataKey, activity, activity.quantityCt, "quantity_ct")!).abs().toString()
    : null;
  const gross = activity?.grossAmountCt
    ? new Decimal(text(dataKey, activity, activity.grossAmountCt, "gross_amount_ct")!).abs()
    : activity?.priceCt && saleQuantity
      ? new Decimal(text(dataKey, activity, activity.priceCt, "price_ct")!).mul(saleQuantity)
      : null;
  const fee = activity?.feeAmountCt
    ? new Decimal(text(dataKey, activity, activity.feeAmountCt, "fee_amount_ct")!).abs()
    : new Decimal(0);
  const tax = activity?.taxAmountCt
    ? new Decimal(text(dataKey, activity, activity.taxAmountCt, "tax_amount_ct")!).abs()
    : new Decimal(0);
  const eligibleLots =
    row.kind === "unresolved_disposal" && activity && instrumentId
      ? context.lots
          .filter(
            (lot) =>
              lot.accountId === row.accountId &&
              lot.instrumentId === instrumentId &&
              lot.policyVersion === row.policyVersion &&
              lot.tradeDate <= activity.tradeDate &&
              new Decimal(text(dataKey, lot, lot.remainingQuantityCt, "remaining_quantity_ct")!).gt(
                0,
              ),
          )
          .map((lot): EligibleLotView => ({
            id: lot.id,
            acquisitionDate: lot.tradeDate,
            remainingQuantity: text(
              dataKey,
              lot,
              lot.remainingQuantityCt,
              "remaining_quantity_ct",
            )!,
            originalQuantity: text(dataKey, lot, lot.originalQuantityCt, "original_quantity_ct")!,
            nativeCostBasis: text(dataKey, lot, lot.costBasisCt, "cost_basis_ct")!,
            currency: lot.costBasisCurrency,
            lockedFxRate: text(dataKey, lot, lot.lockedFxRateCt, "locked_fx_rate_ct"),
            lockedFxState:
              lot.lockedFxProvenance === "boi_derived"
                ? "Bank of Israel"
                : lot.lockedFxProvenance === "user_entered"
                  ? "User entered"
                  : "Unavailable",
            lockedFxDate: lot.lockedFxObservationDate,
            completeness: lot.completeness,
          }))
      : [];
  const durableIdentifiers = instrumentId
    ? context.mappings
        .filter((mapping) => mapping.instrumentId === instrumentId)
        .map((mapping) => ({
          label: `${sourceLabel(mapping.provider)} · ${mapping.identifierKind.replaceAll("_", " ")}`,
          value: text(dataKey, mapping, mapping.providerIdentifierCt, "provider_identifier_ct")!,
        }))
    : [];
  const expected = quality?.expectedValueCt
    ? text(dataKey, quality, quality.expectedValueCt, "expected_value_ct")
    : null;
  const observed = quality?.observedValueCt
    ? text(dataKey, quality, quality.observedValueCt, "observed_value_ct")
    : null;
  const openingQuantity =
    quality?.dimension === "position_quantity" &&
    expected !== null &&
    observed !== null &&
    new Decimal(expected).gt(observed)
      ? new Decimal(expected).minus(observed).toString()
      : null;
  return {
    id: row.id,
    kind: row.kind,
    kindLabel: presentation.label,
    status: row.status,
    accountId: row.accountId,
    accountName: account
      ? text(dataKey, account, account.nameCt, "name_ct") || "Investment account"
      : "Investment account",
    instrumentId,
    instrumentLabel: instrumentLabel(dataKey, context.instrumentById.get(instrumentId ?? "")),
    eventDate: activity?.tradeDate ?? null,
    eventDateLabel: dateLabel(activity?.tradeDate ?? quality?.createdAt ?? null),
    consequence: presentation.consequence,
    affectedMetrics: presentation.metrics,
    retainedDetails: row.detailsCt ? text(dataKey, row, row.detailsCt, "details_ct") : null,
    resolvedAtLabel: dateLabel(row.resolvedAt),
    sale:
      row.kind === "unresolved_disposal" && activity && saleQuantity && gross && activity.currency
        ? {
            quantity: saleQuantity,
            quantityUnit: activity.quantityUnit ?? "units",
            proceeds: gross.minus(fee).minus(tax).toString(),
            currency: activity.currency,
            source: sourceLabel(activity.source),
            description: text(dataKey, activity, activity.rawDescriptionCt, "raw_description_ct"),
            eligibleLots,
            resolvedAllocations: parseResolvedAllocations(dataKey, row).map((allocation) => {
              const lot = context.lots.find((held) => held.id === allocation.lotId);
              const closure = context.closures.find(
                (held) =>
                  held.closedTaxLotId === allocation.lotId &&
                  held.sellActivityEvidenceId === row.activityEvidenceId,
              );
              return {
                ...allocation,
                acquisitionDate: lot?.tradeDate ?? null,
                nativeRealizedCostBasis: closure
                  ? text(dataKey, closure, closure.realizedCostBasisCt, "realized_cost_basis_ct")
                  : null,
                nativeProceeds: closure
                  ? text(dataKey, closure, closure.proceedsCt, "proceeds_ct")
                  : null,
              };
            }),
          }
        : null,
    identity:
      row.kind === "identity_ambiguity" && activity
        ? {
            source: sourceLabel(activity.source),
            description: text(dataKey, activity, activity.rawDescriptionCt, "raw_description_ct"),
            amount: activity.netCashAmountCt
              ? text(dataKey, activity, activity.netCashAmountCt, "net_cash_amount_ct")
              : null,
            currency: activity.currency,
            durableIdentifiers,
            limitation:
              "Moni retained the recorded activity, but the conflicting candidate was not stored. This item cannot be resolved in-app yet; re-import corrected source data to replace the ambiguity.",
          }
        : null,
    gap:
      row.kind === "reconciliation_gap" && quality
        ? {
            dimensionLabel: quality.dimension.replaceAll("_", " "),
            expected,
            observed,
            currency: quality.currency,
            openingQuantity,
            canAddOpeningLot: Boolean(openingQuantity && instrumentId),
          }
        : null,
  };
}

async function openingLotSummary(tx: Tx, session: Session): Promise<OpeningLotsAccountView[]> {
  const accountRows = await tx
    .select()
    .from(accounts)
    .where(eq(accounts.accountType, "investment"))
    .orderBy(asc(accounts.createdAt));
  const openingRows = await tx.select().from(investmentOpeningLotEvidence);
  const coverageRows = await tx
    .select()
    .from(investmentActivityCoverage)
    .where(eq(investmentActivityCoverage.metric, "cost_basis"));
  return accountRows.map((account) => {
    const held = openingRows.filter((row) => row.accountId === account.id);
    const qualities = coverageRows
      .filter((row) => row.accountId === account.id)
      .map((row) => row.completeness);
    const completeness = qualities.includes("unknown")
      ? "unknown"
      : qualities.includes("partial")
        ? "partial"
        : qualities.length > 0
          ? "complete"
          : "unknown";
    const last = held.map((row) => row.createdAt).sort((a, b) => b.getTime() - a.getTime())[0];
    return {
      accountId: account.id,
      accountName:
        text(session.dataKey, account, account.nameCt, "name_ct") || "Investment account",
      lotCount: held.length,
      completeness,
      lastImportLabel: dateLabel(last ?? null),
    };
  });
}

export function readInvestmentActivity(session: Session): Promise<InvestmentActivityView> {
  return withUser(session.userId, async (tx) => {
    const pendingRows = await tx
      .select()
      .from(investmentDisposalResolutionQueue)
      .where(
        and(
          eq(investmentDisposalResolutionQueue.status, "pending"),
          or(
            isNull(investmentDisposalResolutionQueue.reconciliationQualityId),
            inArray(
              investmentDisposalResolutionQueue.reconciliationQualityId,
              tx
                .select({ id: investmentReconciliationQuality.id })
                .from(investmentReconciliationQuality)
                .where(currentReconciliationSnapshot()),
            ),
          ),
        ),
      )
      .orderBy(asc(investmentDisposalResolutionQueue.createdAt));
    const resolvedRows = await tx
      .select()
      .from(investmentDisposalResolutionQueue)
      .where(eq(investmentDisposalResolutionQueue.status, "resolved"))
      .orderBy(desc(investmentDisposalResolutionQueue.resolvedAt))
      .limit(12);
    const openingLots = await openingLotSummary(tx, session);
    const rows = [...pendingRows, ...resolvedRows];
    const context = await readContext(tx, rows);
    const pending = pendingRows.map((row) => toItem(session.dataKey, row, context));
    return {
      pending,
      recentlyResolved: resolvedRows.map((row) => toItem(session.dataKey, row, context)),
      pendingCount: pending.length,
      counts: {
        sales: pending.filter((row) => row.kind === "unresolved_disposal").length,
        identity: pending.filter((row) => row.kind === "identity_ambiguity").length,
        historyGaps: pending.filter((row) => row.kind === "reconciliation_gap").length,
      },
      openingLots,
    };
  });
}

export function readInvestmentResolutionItem(
  session: Session,
  queueId: string,
): Promise<InvestmentResolutionItemView | null> {
  return withUser(session.userId, async (tx) => {
    const [row] = await tx
      .select()
      .from(investmentDisposalResolutionQueue)
      .where(eq(investmentDisposalResolutionQueue.id, queueId))
      .limit(1);
    if (!row) return null;
    return toItem(session.dataKey, row, await readContext(tx, [row]));
  });
}

async function disposalPreview(
  tx: Tx,
  session: Session,
  queueId: string,
  allocations: DisposalAllocationInput[],
  requirePending: boolean,
): Promise<DisposalResolutionPreview> {
  const [queue] = await tx
    .select()
    .from(investmentDisposalResolutionQueue)
    .where(eq(investmentDisposalResolutionQueue.id, queueId))
    .limit(1);
  if (!queue) throw new InvestmentResolutionError("not_found");
  if (queue.kind !== "unresolved_disposal" || !queue.activityEvidenceId)
    throw new InvestmentResolutionError("unsupported_kind");
  if (requirePending && queue.status !== "pending")
    throw new InvestmentResolutionError("already_resolved");
  const [sale] = await tx
    .select()
    .from(investmentActivityEvidence)
    .where(eq(investmentActivityEvidence.id, queue.activityEvidenceId))
    .limit(1);
  if (
    !sale ||
    sale.activityType !== "sell" ||
    !sale.instrumentId ||
    !sale.quantityCt ||
    !sale.currency
  )
    throw new InvestmentResolutionError("invalid_allocation");
  const saleQuantity = new Decimal(
    text(session.dataKey, sale, sale.quantityCt, "quantity_ct")!,
  ).abs();
  const unique = new Set(allocations.map((allocation) => allocation.lotId));
  let allocated = new Decimal(0);
  try {
    for (const allocation of allocations) {
      const quantity = new Decimal(allocation.quantity);
      if (!quantity.isFinite() || !quantity.isPositive())
        throw new InvestmentResolutionError("invalid_allocation");
      allocated = allocated.plus(quantity);
    }
  } catch (error) {
    if (error instanceof InvestmentResolutionError) throw error;
    throw new InvestmentResolutionError("invalid_allocation");
  }
  if (
    allocations.length === 0 ||
    unique.size !== allocations.length ||
    !allocated.equals(saleQuantity)
  )
    throw new InvestmentResolutionError("invalid_allocation");
  const lotRows = await tx
    .select()
    .from(investmentTaxLots)
    .where(
      inArray(
        investmentTaxLots.id,
        allocations.map((allocation) => allocation.lotId),
      ),
    );
  const byId = new Map(lotRows.map((lot) => [lot.id, lot]));
  let nativeBasis = new Decimal(0);
  let ilsBasis = new Decimal(0);
  let completeFx = true;
  const previewAllocations = allocations.map((allocation) => {
    const lot = byId.get(allocation.lotId);
    const quantity = new Decimal(allocation.quantity);
    if (
      !lot ||
      lot.accountId !== queue.accountId ||
      lot.instrumentId !== sale.instrumentId ||
      lot.policyVersion !== queue.policyVersion ||
      lot.tradeDate > sale.tradeDate ||
      lot.costBasisCurrency !== sale.currency
    )
      throw new InvestmentResolutionError("invalid_allocation");
    const remaining = new Decimal(
      text(session.dataKey, lot, lot.remainingQuantityCt, "remaining_quantity_ct")!,
    );
    if (quantity.gt(remaining)) throw new InvestmentResolutionError("invalid_allocation");
    const basis = new Decimal(text(session.dataKey, lot, lot.costBasisCt, "cost_basis_ct")!)
      .mul(quantity)
      .div(text(session.dataKey, lot, lot.originalQuantityCt, "original_quantity_ct")!);
    nativeBasis = nativeBasis.plus(basis);
    const rate = text(session.dataKey, lot, lot.lockedFxRateCt, "locked_fx_rate_ct");
    if (rate === null) completeFx = false;
    else ilsBasis = ilsBasis.plus(basis.mul(rate));
    return {
      lotId: lot.id,
      acquisitionDate: lot.tradeDate,
      quantity: quantity.toString(),
      nativeRealizedCostBasis: basis.toString(),
    };
  });
  const gross = sale.grossAmountCt
    ? new Decimal(text(session.dataKey, sale, sale.grossAmountCt, "gross_amount_ct")!).abs()
    : sale.priceCt
      ? new Decimal(text(session.dataKey, sale, sale.priceCt, "price_ct")!).abs().mul(saleQuantity)
      : null;
  if (!gross) throw new InvestmentResolutionError("invalid_allocation");
  const fee = sale.feeAmountCt
    ? new Decimal(text(session.dataKey, sale, sale.feeAmountCt, "fee_amount_ct")!).abs()
    : new Decimal(0);
  const tax = sale.taxAmountCt
    ? new Decimal(text(session.dataKey, sale, sale.taxAmountCt, "tax_amount_ct")!).abs()
    : new Decimal(0);
  const proceeds = gross.minus(fee).minus(tax);
  const saleFx = await lockAcquisitionFx(tx, {
    tradeDate: sale.tradeDate,
    settlementDate: sale.settlementDate ?? undefined,
    fromCurrency: sale.currency,
    toCurrency: "ILS",
  });
  if (!saleFx.rateString) completeFx = false;
  return {
    queueId,
    saleQuantity: saleQuantity.toString(),
    allocatedQuantity: allocated.toString(),
    currency: sale.currency,
    nativeProceeds: proceeds.toString(),
    nativeRealizedCostBasis: nativeBasis.toString(),
    ilsGainIncludesFx:
      completeFx && saleFx.rateString
        ? proceeds.mul(saleFx.rateString).minus(ilsBasis).toString()
        : null,
    completeness: completeFx ? "complete" : "partial",
    allocations: previewAllocations,
  };
}

export function previewDisposalResolution(
  session: Session,
  queueId: string,
  allocations: DisposalAllocationInput[],
): Promise<DisposalResolutionPreview> {
  return withUser(session.userId, (tx) => disposalPreview(tx, session, queueId, allocations, true));
}

export function resolveDisposal(
  session: Session,
  queueId: string,
  allocations: DisposalAllocationInput[],
): Promise<{
  preview: DisposalResolutionPreview;
  derivation: InvestmentTaxLotDerivationResult;
  resolvedAt: string;
}> {
  return withUser(session.userId, async (tx) => {
    const preview = await disposalPreview(tx, session, queueId, allocations, true);
    const [queue] = await tx
      .select()
      .from(investmentDisposalResolutionQueue)
      .where(eq(investmentDisposalResolutionQueue.id, queueId))
      .limit(1);
    const [sale] = await tx
      .select()
      .from(investmentActivityEvidence)
      .where(eq(investmentActivityEvidence.id, queue.activityEvidenceId!))
      .limit(1);
    const version = queue.version + 1;
    const resolvedAt = new Date();
    const canonical = preview.allocations.map(({ lotId, quantity }) => ({ lotId, quantity }));
    const updated = await tx
      .update(investmentDisposalResolutionQueue)
      .set({
        status: "resolved",
        resolvedAt,
        detailsCt: encText(
          session.dataKey,
          JSON.stringify({ type: "disposal_allocation", allocations: canonical }),
          queue.id,
          "details_ct",
          version,
        ),
        version,
      })
      .where(
        and(
          eq(investmentDisposalResolutionQueue.id, queueId),
          eq(investmentDisposalResolutionQueue.status, "pending"),
        ),
      )
      .returning({ id: investmentDisposalResolutionQueue.id });
    if (updated.length !== 1) throw new InvestmentResolutionError("already_resolved");
    const derivation = await deriveInvestmentTaxLotsInTransaction(tx, {
      userId: session.userId,
      accountId: queue.accountId,
      instrumentId: sale.instrumentId!,
      policyVersion: queue.policyVersion,
      dataKey: session.dataKey,
    });
    return { preview, derivation, resolvedAt: resolvedAt.toISOString() };
  });
}
