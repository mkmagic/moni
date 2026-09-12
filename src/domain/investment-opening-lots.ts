import { createHmac, randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { eq } from "drizzle-orm";

import { withUser, type UserTransaction } from "@/db/client";
import {
  accounts,
  instruments,
  instrumentSourceMappings,
  investmentOpeningLotEvidence,
} from "@/db/schema";
import type { OpeningLotImportRow } from "@/lib/investments";
import { decText, encText } from "./fields";
import { lockAcquisitionFx } from "./investment-fx";

type Tx = UserTransaction;

export class OpeningLotImportError extends Error {
  constructor(readonly code: "account_not_found" | "identity_conflict" | "invalid_fx_override") {
    super(code);
    this.name = "OpeningLotImportError";
  }
}

export interface OpeningLotPreviewRow extends OpeningLotImportRow {
  status: "ready" | "skipped_duplicate";
  lockedFxRate: string | null;
  lockedFxConvention: string | null;
  lockedFxObservationDate: string | null;
  lockedFxProvenance: "boi_derived" | "user_entered" | "unresolved";
}

export interface OpeningLotImportPreview {
  rows: OpeningLotPreviewRow[];
  ready: number;
  skipped: number;
  unresolvedFx: number;
}

export interface OpeningLotImportResult {
  inserted: number;
  skipped: number;
  unresolvedFx: number;
}

export interface OpeningLotImportInput {
  userId: string;
  /** Tier-1 data key. The caller owns its lifetime and wiping. */
  dataKey: Uint8Array;
  rows: OpeningLotImportRow[];
}

interface ResolvedIdentity {
  kind: "isin" | "symbol_exchange";
  value: string;
}

interface ResolvedFx {
  rate: string | null;
  convention: string | null;
  observationDate: string | null;
  provenance: "boi_derived" | "user_entered" | "unresolved";
}

function identity(row: OpeningLotImportRow): ResolvedIdentity {
  return row.isin
    ? { kind: "isin", value: row.isin }
    : { kind: "symbol_exchange", value: `${row.symbol!}@${row.exchange!}` };
}

function importKey(dataKey: Uint8Array, row: OpeningLotImportRow): Buffer {
  const sourceIdentity = row.brokerLotId
    ? ["broker_lot_id", row.account, row.brokerLotId]
    : [
        "composite",
        row.account,
        identity(row).kind,
        identity(row).value,
        row.tradeDate,
        row.quantity,
        row.remainingQuantity,
        row.unitCost ?? "",
        row.totalCost,
        row.currency,
        row.fee ?? "",
      ];
  return createHmac("sha256", dataKey)
    .update("opening-lot-import\0")
    .update(JSON.stringify(sourceIdentity))
    .digest();
}

async function accountId(
  tx: Tx,
  input: OpeningLotImportInput,
  accountRef: string,
): Promise<string> {
  const rows = await tx.select().from(accounts).where(eq(accounts.accountType, "investment"));
  for (const row of rows) {
    if (!row.externalAccountRefCt) continue;
    const held = decText(
      input.dataKey,
      row.externalAccountRefCt,
      row.id,
      "external_account_ref_ct",
      row.version,
    );
    if (held === accountRef) return row.id;
  }
  throw new OpeningLotImportError("account_not_found");
}

async function existingInstrumentId(
  tx: Tx,
  input: OpeningLotImportInput,
  row: OpeningLotImportRow,
): Promise<string | null> {
  const target = identity(row);
  const mappings = await tx.select().from(instrumentSourceMappings);
  for (const mapping of mappings) {
    const identifier = decText(
      input.dataKey,
      mapping.providerIdentifierCt,
      mapping.id,
      "provider_identifier_ct",
      mapping.version,
    );
    if (mapping.identifierKind === target.kind && identifier === target.value) {
      if (mapping.currency !== row.currency) throw new OpeningLotImportError("identity_conflict");
      return mapping.instrumentId;
    }
    if (target.kind !== "symbol_exchange" || !mapping.providerSymbolCt || !mapping.exchangeCt)
      continue;
    const symbol = decText(
      input.dataKey,
      mapping.providerSymbolCt,
      mapping.id,
      "provider_symbol_ct",
      mapping.version,
    );
    const exchange = decText(
      input.dataKey,
      mapping.exchangeCt,
      mapping.id,
      "exchange_ct",
      mapping.version,
    );
    if (`${symbol}@${exchange}` === target.value) {
      if (mapping.currency !== row.currency) throw new OpeningLotImportError("identity_conflict");
      return mapping.instrumentId;
    }
  }
  return null;
}

async function resolveInstrumentId(
  tx: Tx,
  input: OpeningLotImportInput,
  row: OpeningLotImportRow,
): Promise<string> {
  const existing = await existingInstrumentId(tx, input, row);
  const target = identity(row);
  const instrumentId = existing ?? randomUUID();
  if (!existing) {
    await tx.insert(instruments).values({
      id: instrumentId,
      ownerId: input.userId,
      kind: "generic",
      canonicalSymbolCt: row.symbol
        ? encText(input.dataKey, row.symbol, instrumentId, "canonical_symbol_ct", 1)
        : null,
    });
  }
  const mappings = await tx
    .select()
    .from(instrumentSourceMappings)
    .where(eq(instrumentSourceMappings.provider, "opening_lot_import"));
  for (const mapping of mappings) {
    const identifier = decText(
      input.dataKey,
      mapping.providerIdentifierCt,
      mapping.id,
      "provider_identifier_ct",
      mapping.version,
    );
    if (mapping.identifierKind !== target.kind || identifier !== target.value) continue;
    if (mapping.instrumentId !== instrumentId || mapping.currency !== row.currency)
      throw new OpeningLotImportError("identity_conflict");
    return instrumentId;
  }
  const mappingId = randomUUID();
  await tx.insert(instrumentSourceMappings).values({
    id: mappingId,
    ownerId: input.userId,
    instrumentId,
    provider: "opening_lot_import",
    identifierKind: target.kind,
    providerIdentifierCt: encText(
      input.dataKey,
      target.value,
      mappingId,
      "provider_identifier_ct",
      1,
    ),
    providerSymbolCt: row.symbol
      ? encText(input.dataKey, row.symbol, mappingId, "provider_symbol_ct", 1)
      : null,
    exchangeCt: row.exchange
      ? encText(input.dataKey, row.exchange, mappingId, "exchange_ct", 1)
      : null,
    currency: row.currency,
  });
  return instrumentId;
}

async function resolveFx(tx: Tx, row: OpeningLotImportRow): Promise<ResolvedFx> {
  // An ILS acquisition needs no conversion; the rate is the definitional
  // identity, so skip FX resolution and never emit a nonsensical ILS_PER_ILS
  // convention label.
  if (row.currency === "ILS") {
    return { rate: "1", convention: null, observationDate: null, provenance: "boi_derived" };
  }
  if (row.ilsFxRate) {
    // A user-entered override is persisted as locked evidence, so validate it is
    // a positive decimal in the BoI (ILS-per-foreign) direction before trusting it.
    let override: Decimal;
    try {
      override = new Decimal(row.ilsFxRate);
    } catch {
      throw new OpeningLotImportError("invalid_fx_override");
    }
    if (!override.isFinite() || override.lte(0)) {
      throw new OpeningLotImportError("invalid_fx_override");
    }
    return {
      rate: row.ilsFxRate,
      convention: `ILS_PER_${row.currency}`,
      observationDate: null,
      provenance: "user_entered",
    };
  }
  const locked = await lockAcquisitionFx(tx, {
    tradeDate: row.tradeDate,
    fromCurrency: row.currency,
    toCurrency: "ILS",
  });
  return {
    rate: locked.rateString,
    convention: locked.rateString ? locked.convention : null,
    observationDate: locked.observationDate,
    provenance: locked.provenance,
  };
}

async function preview(tx: Tx, input: OpeningLotImportInput): Promise<OpeningLotImportPreview> {
  const heldKeys: Uint8Array[] = (
    await tx
      .select({ key: investmentOpeningLotEvidence.idempotencyKey })
      .from(investmentOpeningLotEvidence)
  ).map(({ key }) => Buffer.from(key));
  const rows: OpeningLotPreviewRow[] = [];
  for (const row of input.rows) {
    await accountId(tx, input, row.account);
    await existingInstrumentId(tx, input, row);
    const key = importKey(input.dataKey, row);
    const duplicate = heldKeys.some((held) => Buffer.from(held).equals(key));
    heldKeys.push(key);
    const fx = await resolveFx(tx, row);
    rows.push({
      ...row,
      status: duplicate ? "skipped_duplicate" : "ready",
      lockedFxRate: fx.rate,
      lockedFxConvention: fx.convention,
      lockedFxObservationDate: fx.observationDate,
      lockedFxProvenance: fx.provenance,
    });
  }
  return {
    rows,
    ready: rows.filter((row) => row.status === "ready").length,
    skipped: rows.filter((row) => row.status === "skipped_duplicate").length,
    unresolvedFx: rows.filter((row) => row.lockedFxProvenance === "unresolved").length,
  };
}

/** Read-only validation and duplicate/FX preview. */
export function previewOpeningLotImport(
  input: OpeningLotImportInput,
): Promise<OpeningLotImportPreview> {
  return withUser(input.userId, (tx) => preview(tx, input));
}

/** Revalidates and promotes every non-duplicate row in one owner-scoped transaction. */
export function promoteOpeningLotImport(
  input: OpeningLotImportInput,
): Promise<OpeningLotImportResult> {
  return withUser(input.userId, async (tx) => {
    const result: OpeningLotImportResult = { inserted: 0, skipped: 0, unresolvedFx: 0 };
    for (const row of input.rows) {
      const key = importKey(input.dataKey, row);
      const [duplicate] = await tx
        .select({ id: investmentOpeningLotEvidence.id })
        .from(investmentOpeningLotEvidence)
        .where(eq(investmentOpeningLotEvidence.idempotencyKey, key))
        .limit(1);
      if (duplicate) {
        result.skipped++;
        continue;
      }
      const resolvedAccountId = await accountId(tx, input, row.account);
      const instrumentId = await resolveInstrumentId(tx, input, row);
      const fx = await resolveFx(tx, row);
      const id = randomUUID();
      await tx.insert(investmentOpeningLotEvidence).values({
        id,
        ownerId: input.userId,
        accountId: resolvedAccountId,
        instrumentId,
        idempotencyKey: key,
        brokerLotIdCt: row.brokerLotId
          ? encText(input.dataKey, row.brokerLotId, id, "broker_lot_id_ct", 1)
          : null,
        tradeDate: row.tradeDate,
        originalQuantityCt: encText(input.dataKey, row.quantity, id, "original_quantity_ct", 1),
        remainingQuantityCt: encText(
          input.dataKey,
          row.remainingQuantity,
          id,
          "remaining_quantity_ct",
          1,
        ),
        quantityUnit: "shares",
        unitCostCt: row.unitCost
          ? encText(input.dataKey, row.unitCost, id, "unit_cost_ct", 1)
          : null,
        totalCostCt: encText(input.dataKey, row.totalCost, id, "total_cost_ct", 1),
        feesCt: row.fee ? encText(input.dataKey, row.fee, id, "fees_ct", 1) : null,
        currency: row.currency,
        lockedFxRateCt: fx.rate
          ? encText(input.dataKey, fx.rate, id, "locked_fx_rate_ct", 1)
          : null,
        lockedFxConvention: fx.convention,
        lockedFxObservationDate: fx.observationDate,
        lockedFxProvenance: fx.provenance,
        provenance: "imported",
      });
      result.inserted++;
      if (fx.provenance === "unresolved") result.unresolvedFx++;
    }
    return result;
  });
}
