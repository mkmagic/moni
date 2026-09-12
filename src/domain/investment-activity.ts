import { createHmac, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { withUser, type UserTransaction } from "@/db/client";
import {
  accounts,
  connections,
  instruments,
  instrumentSourceMappings,
  investmentActivityEvidence,
  investmentCorporateActionEvidence,
  investmentDisposalResolutionQueue,
  investmentOpeningLotEvidence,
  syncRuns,
} from "@/db/schema";
import type {
  IbkrCorporateActionEvidence,
  IbkrFlexActivityEvidenceSet,
  InvestmentActivityEvidence,
  OpenLotEvidence,
} from "@/lib/investments";
import { decText, encText } from "./fields";
import { lockAcquisitionFx } from "./investment-fx";

type Tx = UserTransaction;

export class InvestmentActivityIngestionError extends Error {
  constructor(readonly code: "invalid_sync" | "identity_conflict" | "incomplete_coverage") {
    super(code);
    this.name = "InvestmentActivityIngestionError";
  }
}

export interface InvestmentActivityIngestionResult {
  activitiesInserted: number;
  activitiesUpdated: number;
  activitiesSkipped: number;
  openingLotsInserted: number;
  openingLotsSkipped: number;
  corporateActionsInserted: number;
  corporateActionsSkipped: number;
  identityAmbiguitiesQueued: number;
}

export interface InvestmentActivityIngestionInput {
  userId: string;
  connectionId: string;
  syncRunId: string;
  /** Tier-1 data key. The caller owns its lifetime and wiping. */
  dataKey: Uint8Array;
  evidence: IbkrFlexActivityEvidenceSet | IbkrFlexActivityEvidenceSet[];
}

function fail(code: InvestmentActivityIngestionError["code"]): never {
  throw new InvestmentActivityIngestionError(code);
}

function keyedIdentity(dataKey: Uint8Array, kind: string, value: string): Buffer {
  return createHmac("sha256", dataKey).update(kind).update("\0").update(value).digest();
}

function encrypted(
  dataKey: Uint8Array,
  value: string | undefined,
  id: string,
  field: string,
  version: number,
): Buffer | null {
  return value === undefined ? null : encText(dataKey, value, id, field, version);
}

async function validateSync(tx: Tx, input: InvestmentActivityIngestionInput): Promise<void> {
  const [connection] = await tx
    .select()
    .from(connections)
    .where(eq(connections.id, input.connectionId))
    .limit(1);
  const [run] = await tx.select().from(syncRuns).where(eq(syncRuns.id, input.syncRunId)).limit(1);
  if (
    !connection ||
    connection.connectorId !== "ibkr_flex" ||
    !run ||
    run.connectionId !== input.connectionId ||
    run.status !== "running"
  )
    fail("invalid_sync");
}

async function resolveAccount(
  tx: Tx,
  input: InvestmentActivityIngestionInput,
  sourceAccountRef: string,
): Promise<string> {
  const rows = await tx
    .select()
    .from(accounts)
    .where(eq(accounts.connectionId, input.connectionId));
  for (const row of rows) {
    if (!row.externalAccountRefCt) continue;
    if (
      decText(
        input.dataKey,
        row.externalAccountRefCt,
        row.id,
        "external_account_ref_ct",
        row.version,
      ) !== sourceAccountRef
    )
      continue;
    if (row.accountType !== "investment") fail("identity_conflict");
    return row.id;
  }
  fail("incomplete_coverage");
}

async function resolveInstrument(
  tx: Tx,
  input: InvestmentActivityIngestionInput,
  sourceSecurityId: string | undefined,
  sourceSecurityIdKind: string | undefined,
  currency: string | undefined,
): Promise<string | null> {
  if (!sourceSecurityId || !sourceSecurityIdKind) return null;
  const mappings = await tx
    .select()
    .from(instrumentSourceMappings)
    .where(eq(instrumentSourceMappings.provider, "ibkr_flex"));
  for (const mapping of mappings) {
    if (mapping.identifierKind !== sourceSecurityIdKind) continue;
    const identifier = decText(
      input.dataKey,
      mapping.providerIdentifierCt,
      mapping.id,
      "provider_identifier_ct",
      mapping.version,
    );
    if (identifier !== sourceSecurityId) continue;
    if (currency && mapping.currency !== currency) fail("identity_conflict");
    return mapping.instrumentId;
  }
  if (!currency) return null;
  const instrumentId = randomUUID();
  const mappingId = randomUUID();
  await tx.insert(instruments).values({
    id: instrumentId,
    ownerId: input.userId,
    kind: "generic",
  });
  await tx.insert(instrumentSourceMappings).values({
    id: mappingId,
    ownerId: input.userId,
    instrumentId,
    provider: "ibkr_flex",
    identifierKind: sourceSecurityIdKind,
    providerIdentifierCt: encText(
      input.dataKey,
      sourceSecurityId,
      mappingId,
      "provider_identifier_ct",
      1,
    ),
    currency,
  });
  return instrumentId;
}

function activityValues(
  input: InvestmentActivityIngestionInput,
  evidence: InvestmentActivityEvidence,
  id: string,
  accountId: string,
  instrumentId: string | null,
  version: number,
  revisionOfId: string | null,
) {
  const tradeId = evidence.sourceRevisionOfId ?? evidence.sourceTradeId;
  return {
    ownerId: input.userId,
    connectionId: input.connectionId,
    syncRunId: input.syncRunId,
    accountId,
    instrumentId,
    revisionOfId,
    source: evidence.source,
    activityType: evidence.activityType,
    providerActivityIdCt: encrypted(
      input.dataKey,
      evidence.sourceActivityId,
      id,
      "provider_activity_id_ct",
      version,
    ),
    providerExecutionIdCt: encrypted(
      input.dataKey,
      evidence.sourceExecutionId,
      id,
      "provider_execution_id_ct",
      version,
    ),
    providerTradeIdCt: encrypted(input.dataKey, tradeId, id, "provider_trade_id_ct", version),
    brokerOpenDateTimeCt: encrypted(
      input.dataKey,
      evidence.brokerOpenDateTime,
      id,
      "broker_open_date_time_ct",
      version,
    ),
    brokerLotAllocationsCt: encrypted(
      input.dataKey,
      evidence.brokerLotAllocations ? JSON.stringify(evidence.brokerLotAllocations) : undefined,
      id,
      "broker_lot_allocations_ct",
      version,
    ),
    tradeDate: evidence.tradeDate,
    settlementDate: evidence.settlementDate ?? null,
    quantityCt: encrypted(input.dataKey, evidence.quantity, id, "quantity_ct", version),
    quantityUnit: evidence.quantityUnit ?? null,
    priceCt: encrypted(input.dataKey, evidence.price, id, "price_ct", version),
    grossAmountCt: encrypted(input.dataKey, evidence.grossAmount, id, "gross_amount_ct", version),
    feeAmountCt: encrypted(input.dataKey, evidence.feeAmount, id, "fee_amount_ct", version),
    taxAmountCt: encrypted(input.dataKey, evidence.taxAmount, id, "tax_amount_ct", version),
    netCashAmountCt: encrypted(
      input.dataKey,
      evidence.netCashAmount,
      id,
      "net_cash_amount_ct",
      version,
    ),
    currency: evidence.currency ?? null,
    rawTypeCt: encText(input.dataKey, evidence.rawType, id, "raw_type_ct", version),
    rawCodeCt: encrypted(input.dataKey, evidence.rawCode, id, "raw_code_ct", version),
    rawDescriptionCt: encrypted(
      input.dataKey,
      evidence.rawDescription,
      id,
      "raw_description_ct",
      version,
    ),
    provenance: evidence.provenance,
    version,
  };
}

function storedText(
  input: InvestmentActivityIngestionInput,
  row: typeof investmentActivityEvidence.$inferSelect,
  value: Buffer | null,
  field: string,
): string | undefined {
  return decText(input.dataKey, value, row.id, field, row.version) ?? undefined;
}

function isCorrection(evidence: InvestmentActivityEvidence): boolean {
  return (
    evidence.sourceRevisionOfId !== undefined ||
    evidence.rawCode?.split(";").some((code) => /^(?:c|ca)$/i.test(code.trim())) === true ||
    /\bcorrect(?:ed|ion)\b/i.test(evidence.rawDescription ?? "")
  );
}

function sameActivity(
  input: InvestmentActivityIngestionInput,
  row: typeof investmentActivityEvidence.$inferSelect,
  evidence: InvestmentActivityEvidence,
  accountId: string,
  instrumentId: string | null,
): boolean {
  return (
    row.accountId === accountId &&
    row.instrumentId === instrumentId &&
    row.activityType === evidence.activityType &&
    row.tradeDate === evidence.tradeDate &&
    (row.settlementDate ?? undefined) === evidence.settlementDate &&
    storedText(input, row, row.providerActivityIdCt, "provider_activity_id_ct") ===
      evidence.sourceActivityId &&
    storedText(input, row, row.providerExecutionIdCt, "provider_execution_id_ct") ===
      evidence.sourceExecutionId &&
    storedText(input, row, row.providerTradeIdCt, "provider_trade_id_ct") ===
      (evidence.sourceRevisionOfId ?? evidence.sourceTradeId) &&
    storedText(input, row, row.brokerOpenDateTimeCt, "broker_open_date_time_ct") ===
      evidence.brokerOpenDateTime &&
    storedText(input, row, row.brokerLotAllocationsCt, "broker_lot_allocations_ct") ===
      (evidence.brokerLotAllocations ? JSON.stringify(evidence.brokerLotAllocations) : undefined) &&
    storedText(input, row, row.quantityCt, "quantity_ct") === evidence.quantity &&
    (row.quantityUnit ?? undefined) === evidence.quantityUnit &&
    storedText(input, row, row.priceCt, "price_ct") === evidence.price &&
    storedText(input, row, row.grossAmountCt, "gross_amount_ct") === evidence.grossAmount &&
    storedText(input, row, row.feeAmountCt, "fee_amount_ct") === evidence.feeAmount &&
    storedText(input, row, row.taxAmountCt, "tax_amount_ct") === evidence.taxAmount &&
    storedText(input, row, row.netCashAmountCt, "net_cash_amount_ct") === evidence.netCashAmount &&
    (row.currency ?? undefined) === evidence.currency &&
    storedText(input, row, row.rawTypeCt, "raw_type_ct") === evidence.rawType &&
    storedText(input, row, row.rawCodeCt, "raw_code_ct") === evidence.rawCode &&
    storedText(input, row, row.rawDescriptionCt, "raw_description_ct") ===
      evidence.rawDescription &&
    row.provenance === evidence.provenance
  );
}

async function queueAmbiguity(
  tx: Tx,
  input: InvestmentActivityIngestionInput,
  row: typeof investmentActivityEvidence.$inferSelect,
): Promise<boolean> {
  const [held] = await tx
    .select({ id: investmentDisposalResolutionQueue.id })
    .from(investmentDisposalResolutionQueue)
    .where(
      and(
        eq(investmentDisposalResolutionQueue.activityEvidenceId, row.id),
        eq(investmentDisposalResolutionQueue.kind, "identity_ambiguity"),
        eq(investmentDisposalResolutionQueue.status, "pending"),
      ),
    )
    .limit(1);
  if (held) return false;
  const id = randomUUID();
  await tx.insert(investmentDisposalResolutionQueue).values({
    id,
    ownerId: input.userId,
    accountId: row.accountId,
    activityEvidenceId: row.id,
    kind: "identity_ambiguity",
    detailsCt: encText(
      input.dataKey,
      "A keyed source fingerprint matched non-identical activity evidence.",
      id,
      "details_ct",
      1,
    ),
    policyVersion: "activity-identity/v1",
  });
  return true;
}

async function ingestActivity(
  tx: Tx,
  input: InvestmentActivityIngestionInput,
  evidence: InvestmentActivityEvidence,
  result: InvestmentActivityIngestionResult,
): Promise<void> {
  const accountId = await resolveAccount(tx, input, evidence.sourceAccountRef);
  const instrumentId = await resolveInstrument(
    tx,
    input,
    evidence.sourceSecurityId,
    evidence.sourceSecurityIdKind,
    evidence.currency,
  );
  const key = keyedIdentity(input.dataKey, "activity", evidence.idempotencyKey);
  const rows = await tx.select().from(investmentActivityEvidence);
  const exact = rows.find((row) => Buffer.from(row.idempotencyKey).equals(key));
  if (exact) {
    if (sameActivity(input, exact, evidence, accountId, instrumentId)) {
      result.activitiesSkipped++;
      return;
    }
    if (evidence.idempotencyKey.includes(":fp:")) {
      if (await queueAmbiguity(tx, input, exact)) result.identityAmbiguitiesQueued++;
      result.activitiesSkipped++;
      return;
    }
    // An original execution replayed after its correction must not roll the corrected values back.
    if (exact.revisionOfId === exact.id && !evidence.sourceRevisionOfId) {
      result.activitiesSkipped++;
      return;
    }
    const version = exact.version + 1;
    await tx
      .update(investmentActivityEvidence)
      .set(
        activityValues(
          input,
          evidence,
          exact.id,
          accountId,
          instrumentId,
          version,
          isCorrection(evidence) ? exact.id : null,
        ),
      )
      .where(eq(investmentActivityEvidence.id, exact.id));
    result.activitiesUpdated++;
    return;
  }

  let revision: typeof investmentActivityEvidence.$inferSelect | undefined;
  if (evidence.sourceRevisionOfId) {
    revision = rows.find(
      (row) =>
        storedText(input, row, row.providerTradeIdCt, "provider_trade_id_ct") ===
        evidence.sourceRevisionOfId,
    );
  }
  if (revision) {
    const version = revision.version + 1;
    await tx
      .update(investmentActivityEvidence)
      .set(
        activityValues(input, evidence, revision.id, accountId, instrumentId, version, revision.id),
      )
      .where(eq(investmentActivityEvidence.id, revision.id));
    result.activitiesUpdated++;
    return;
  }

  const id = randomUUID();
  await tx.insert(investmentActivityEvidence).values({
    id,
    ...activityValues(input, evidence, id, accountId, instrumentId, 1, null),
    idempotencyKey: key,
  });
  result.activitiesInserted++;
}

async function ingestOpeningLot(
  tx: Tx,
  input: InvestmentActivityIngestionInput,
  evidence: OpenLotEvidence,
  result: InvestmentActivityIngestionResult,
): Promise<void> {
  const accountId = await resolveAccount(tx, input, evidence.sourceAccountRef);
  const instrumentId = await resolveInstrument(
    tx,
    input,
    evidence.sourceSecurityId,
    evidence.sourceSecurityIdKind,
    evidence.currency,
  );
  if (!instrumentId) fail("incomplete_coverage");
  const key = keyedIdentity(input.dataKey, "ibkr-opening-lot", evidence.idempotencyKey);
  const [held] = await tx
    .select({ id: investmentOpeningLotEvidence.id })
    .from(investmentOpeningLotEvidence)
    .where(eq(investmentOpeningLotEvidence.idempotencyKey, key))
    .limit(1);
  if (held) {
    result.openingLotsSkipped++;
    return;
  }
  const fx = await lockAcquisitionFx(tx, {
    tradeDate: evidence.tradeDate,
    settlementDate: evidence.settlementDate,
    fromCurrency: evidence.currency,
    toCurrency: "ILS",
  });
  const id = randomUUID();
  await tx.insert(investmentOpeningLotEvidence).values({
    id,
    ownerId: input.userId,
    accountId,
    instrumentId,
    idempotencyKey: key,
    brokerLotIdCt: encrypted(input.dataKey, evidence.sourceLotId, id, "broker_lot_id_ct", 1),
    tradeDate: evidence.tradeDate,
    settlementDate: evidence.settlementDate ?? null,
    originalQuantityCt: encText(
      input.dataKey,
      evidence.originalQuantity,
      id,
      "original_quantity_ct",
      1,
    ),
    remainingQuantityCt: encText(
      input.dataKey,
      evidence.remainingQuantity,
      id,
      "remaining_quantity_ct",
      1,
    ),
    quantityUnit: evidence.quantityUnit,
    unitCostCt: encrypted(input.dataKey, evidence.unitCost, id, "unit_cost_ct", 1),
    totalCostCt: encText(input.dataKey, evidence.totalCost, id, "total_cost_ct", 1),
    feesCt: encrypted(input.dataKey, evidence.fees, id, "fees_ct", 1),
    currency: evidence.currency,
    lockedFxRateCt: encrypted(
      input.dataKey,
      fx.rateString ?? undefined,
      id,
      "locked_fx_rate_ct",
      1,
    ),
    lockedFxConvention: fx.rateString ? fx.convention : null,
    lockedFxObservationDate: fx.observationDate,
    lockedFxProvenance: fx.provenance,
    provenance: evidence.provenance,
  });
  result.openingLotsInserted++;
}

async function ingestCorporateAction(
  tx: Tx,
  input: InvestmentActivityIngestionInput,
  evidence: IbkrCorporateActionEvidence,
  result: InvestmentActivityIngestionResult,
): Promise<void> {
  const accountId = await resolveAccount(tx, input, evidence.sourceAccountRef);
  const instrumentId = await resolveInstrument(
    tx,
    input,
    evidence.sourceSecurityId,
    evidence.sourceSecurityIdKind,
    evidence.currency,
  );
  const key = keyedIdentity(input.dataKey, "corporate-action", evidence.idempotencyKey);
  const [held] = await tx
    .select({ id: investmentCorporateActionEvidence.id })
    .from(investmentCorporateActionEvidence)
    .where(eq(investmentCorporateActionEvidence.idempotencyKey, key))
    .limit(1);
  if (held) {
    result.corporateActionsSkipped++;
    return;
  }
  const id = randomUUID();
  await tx.insert(investmentCorporateActionEvidence).values({
    id,
    ownerId: input.userId,
    connectionId: input.connectionId,
    syncRunId: input.syncRunId,
    accountId,
    instrumentId,
    source: evidence.source,
    providerActionIdCt: encrypted(
      input.dataKey,
      evidence.sourceActionId,
      id,
      "provider_action_id_ct",
      1,
    ),
    idempotencyKey: key,
    actionDate: evidence.actionDate,
    rawTypeCt: encText(input.dataKey, evidence.rawType, id, "raw_type_ct", 1),
    rawCodeCt: encrypted(input.dataKey, evidence.rawCode, id, "raw_code_ct", 1),
    rawDescriptionCt: encrypted(
      input.dataKey,
      evidence.rawDescription,
      id,
      "raw_description_ct",
      1,
    ),
    quantityCt: encrypted(input.dataKey, evidence.quantity, id, "quantity_ct", 1),
    proceedsCt: encrypted(input.dataKey, evidence.proceeds, id, "proceeds_ct", 1),
    currency: evidence.currency ?? null,
    classification: evidence.classification,
    provenance: evidence.provenance,
  });
  result.corporateActionsInserted++;
}

async function ingest(
  tx: Tx,
  input: InvestmentActivityIngestionInput,
): Promise<InvestmentActivityIngestionResult> {
  await validateSync(tx, input);
  const result: InvestmentActivityIngestionResult = {
    activitiesInserted: 0,
    activitiesUpdated: 0,
    activitiesSkipped: 0,
    openingLotsInserted: 0,
    openingLotsSkipped: 0,
    corporateActionsInserted: 0,
    corporateActionsSkipped: 0,
    identityAmbiguitiesQueued: 0,
  };
  const windows = Array.isArray(input.evidence) ? input.evidence : [input.evidence];
  for (const evidence of windows) {
    for (const activity of evidence.activities) await ingestActivity(tx, input, activity, result);
    for (const openingLot of evidence.openLots)
      await ingestOpeningLot(tx, input, openingLot, result);
    for (const action of evidence.corporateActions)
      await ingestCorporateAction(tx, input, action, result);
  }
  return result;
}

/** Persists normalized activity evidence atomically under the owner's RLS scope. */
export function ingestInvestmentActivityEvidence(
  input: InvestmentActivityIngestionInput,
): Promise<InvestmentActivityIngestionResult> {
  return withUser(input.userId, (tx) => ingest(tx, input));
}
