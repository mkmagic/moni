import { createHmac, randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { and, desc, eq, lte } from "drizzle-orm";
import { withUser, type UserTransaction } from "@/db/client";
import {
  accountBalanceSnapshots,
  accounts,
  connections,
  fxRates,
  instruments,
  instrumentSourceMappings,
  investmentSnapshotCashBalances,
  investmentSnapshotDetails,
  investmentSnapshotPositions,
  investmentSourceEvidence,
  syncRuns,
} from "@/db/schema";
import {
  serializeCanonicalInvestmentEnvelope,
  type InvestmentSyncEnvelope,
} from "@/lib/investments";
import { decText, encText } from "./fields";
import { markSyncRunFailed } from "./sync-promotion";

type Tx = UserTransaction;
type Source = InvestmentSyncEnvelope["source"];

export type InvestmentPromotionErrorCode =
  | "invalid_sync"
  | "incomplete_coverage"
  | "identity_conflict"
  | "stale_source"
  | "missing_fx"
  | "unvalued_position";

/** Safe for worker status only: it never contains source values. */
export class InvestmentPromotionError extends Error {
  constructor(readonly code: InvestmentPromotionErrorCode) {
    super(code);
    this.name = "InvestmentPromotionError";
  }
}

export interface InvestmentPromotionResult {
  outcome: "promoted" | "unchanged";
  accounts: number;
  positions: number;
  cashBalances: number;
}

function fail(code: InvestmentPromotionErrorCode): never {
  throw new InvestmentPromotionError(code);
}

function sourceDate(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) fail("incomplete_coverage");
  return date;
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function sourceCalendarDate(value: string, precision: "date" | "timestamp"): string {
  if (precision === "date") return value.slice(0, 10);
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(sourceDate(value));
  const part = (type: string) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function weekStart(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  const day = value.getUTCDay();
  const sunday = new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate() - day),
  );
  return isoDate(sunday);
}

function fingerprint(dataKey: Uint8Array, envelope: InvestmentSyncEnvelope): Buffer {
  return createHmac("sha256", dataKey)
    .update(serializeCanonicalInvestmentEnvelope(envelope))
    .digest();
}

async function resolveAccount(
  tx: Tx,
  ownerId: string,
  dataKey: Uint8Array,
  connectionId: string,
  source: Source,
  account: InvestmentSyncEnvelope["accounts"][number],
): Promise<string> {
  const rows = await tx.select().from(accounts);
  for (const row of rows) {
    if (!row.externalAccountRefCt) continue;
    if (
      decText(dataKey, row.externalAccountRefCt, row.id, "external_account_ref_ct", row.version) ===
      account.sourceAccountRef
    ) {
      if (
        row.accountType !== "investment" ||
        row.connectionId !== connectionId ||
        row.currency !== account.baseCurrency
      )
        fail("incomplete_coverage");
      return row.id;
    }
  }
  const id = randomUUID();
  const last4 = account.sourceAccountRef.slice(-4);
  await tx.insert(accounts).values({
    id,
    ownerId,
    accountType: "investment",
    classification: "asset",
    connectionId,
    nameCt: encText(dataKey, `${source} (${last4})`, id, "name_ct", 1),
    institution: source,
    accountNumberLast4Ct: encText(dataKey, last4, id, "account_number_last4_ct", 1),
    externalAccountRefCt: encText(
      dataKey,
      account.sourceAccountRef,
      id,
      "external_account_ref_ct",
      1,
    ),
    currency: account.baseCurrency,
    status: "active",
  });
  return id;
}

async function resolveInstrument(
  tx: Tx,
  ownerId: string,
  dataKey: Uint8Array,
  source: Source,
  position: InvestmentSyncEnvelope["accounts"][number]["positions"][number],
): Promise<string> {
  const mappings = await tx.select().from(instrumentSourceMappings);
  for (const mapping of mappings) {
    if (
      mapping.provider !== source &&
      (position.sourceSecurityIdKind === "schwab_symbol" ||
        position.sourceSecurityIdKind === "conid")
    )
      continue;
    const identifier = decText(
      dataKey,
      mapping.providerIdentifierCt,
      mapping.id,
      "provider_identifier_ct",
      mapping.version,
    );
    if (
      mapping.identifierKind !== position.sourceSecurityIdKind ||
      identifier !== position.sourceSecurityId
    )
      continue;
    const [instrument] = await tx
      .select()
      .from(instruments)
      .where(eq(instruments.id, mapping.instrumentId))
      .limit(1);
    if (
      !instrument ||
      instrument.kind !== position.assetKind ||
      mapping.currency !== position.currency
    )
      fail("identity_conflict");
    if (mapping.provider !== source) {
      const id = randomUUID();
      await tx.insert(instrumentSourceMappings).values({
        id,
        ownerId,
        instrumentId: instrument.id,
        provider: source,
        identifierKind: position.sourceSecurityIdKind,
        providerIdentifierCt: encText(
          dataKey,
          position.sourceSecurityId,
          id,
          "provider_identifier_ct",
          1,
        ),
        providerSymbolCt: position.symbol
          ? encText(dataKey, position.symbol, id, "provider_symbol_ct", 1)
          : null,
        providerNameCt: position.name
          ? encText(dataKey, position.name, id, "provider_name_ct", 1)
          : null,
        exchangeCt: position.exchange
          ? encText(dataKey, position.exchange, id, "exchange_ct", 1)
          : null,
        currency: position.currency,
      });
    }
    return instrument.id;
  }
  const instrumentId = randomUUID();
  const mappingId = randomUUID();
  await tx.insert(instruments).values({
    id: instrumentId,
    ownerId,
    kind: position.assetKind,
    canonicalNameCt: position.name
      ? encText(dataKey, position.name, instrumentId, "canonical_name_ct", 1)
      : null,
    canonicalSymbolCt: position.symbol
      ? encText(dataKey, position.symbol, instrumentId, "canonical_symbol_ct", 1)
      : null,
  });
  await tx.insert(instrumentSourceMappings).values({
    id: mappingId,
    ownerId,
    instrumentId,
    provider: source,
    identifierKind: position.sourceSecurityIdKind,
    providerIdentifierCt: encText(
      dataKey,
      position.sourceSecurityId,
      mappingId,
      "provider_identifier_ct",
      1,
    ),
    providerSymbolCt: position.symbol
      ? encText(dataKey, position.symbol, mappingId, "provider_symbol_ct", 1)
      : null,
    providerNameCt: position.name
      ? encText(dataKey, position.name, mappingId, "provider_name_ct", 1)
      : null,
    exchangeCt: position.exchange
      ? encText(dataKey, position.exchange, mappingId, "exchange_ct", 1)
      : null,
    currency: position.currency,
  });
  return instrumentId;
}

async function ilsRate(tx: Tx, currency: string, asOf: Date): Promise<Decimal> {
  if (currency === "ILS") return new Decimal(1);
  const rows = await tx
    .select()
    .from(fxRates)
    .where(
      and(
        eq(fxRates.fromCurrency, currency),
        eq(fxRates.toCurrency, "ILS"),
        lte(fxRates.date, isoDate(asOf)),
      ),
    )
    .orderBy(desc(fxRates.date))
    .limit(1);
  const row = rows[0];
  if (
    !row ||
    row.source !== "boi" ||
    (asOf.getTime() - Date.parse(`${row.date}T00:00:00Z`)) / 86_400_000 > 7
  )
    fail("missing_fx");
  return new Decimal(row.rate);
}

async function promote(
  tx: Tx,
  input: {
    userId: string;
    connectionId: string;
    syncRunId: string;
    dataKey: Uint8Array;
    envelope: InvestmentSyncEnvelope;
  },
): Promise<InvestmentPromotionResult> {
  const { userId, connectionId, syncRunId, dataKey, envelope } = input;
  if (
    envelope.accounts.length !== envelope.coverage.accountRefs.length ||
    new Set(envelope.coverage.accountRefs).size !== envelope.accounts.length
  )
    fail("incomplete_coverage");
  for (const account of envelope.accounts) {
    if (
      account.positions.length === 0 &&
      account.cash.length === 0 &&
      !new Decimal(account.brokerTotal.amount).isZero()
    )
      fail("incomplete_coverage");
  }
  const [connection] = await tx
    .select()
    .from(connections)
    .where(eq(connections.id, connectionId))
    .limit(1);
  const [run] = await tx.select().from(syncRuns).where(eq(syncRuns.id, syncRunId)).limit(1);
  if (
    !connection ||
    !run ||
    run.connectionId !== connectionId ||
    run.status !== "running" ||
    connection.connectorId !== envelope.source ||
    (envelope.source === "schwab_positions_csv" && connection.mode !== "user_mediated_import")
  )
    fail("invalid_sync");
  if (
    envelope.source === "schwab_positions_csv" &&
    (envelope.accounts.length !== 1 || envelope.coverage.kind !== "bound_single_account")
  )
    fail("incomplete_coverage");

  // A connection's previously accepted account coverage is a completeness
  // contract. Decrypting this small set is intentional: no plaintext index
  // may be introduced for a financial account reference.
  const knownAccounts = await tx
    .select()
    .from(accounts)
    .where(and(eq(accounts.connectionId, connectionId), eq(accounts.accountType, "investment")));
  for (const known of knownAccounts) {
    const ref = decText(
      dataKey,
      known.externalAccountRefCt,
      known.id,
      "external_account_ref_ct",
      known.version,
    );
    if (!ref || !envelope.coverage.accountRefs.includes(ref)) fail("incomplete_coverage");
  }

  const fp = fingerprint(dataKey, envelope);
  const sourceAsOf = sourceDate(envelope.sourceAsOf.value);
  const calendarDate = sourceCalendarDate(envelope.sourceAsOf.value, envelope.sourceAsOf.precision);
  const week = weekStart(calendarDate);
  const ids = new Set(envelope.accounts.map((a) => a.sourceAccountRef));
  if (envelope.coverage.accountRefs.some((id) => !ids.has(id))) fail("incomplete_coverage");
  const resolved = await Promise.all(
    envelope.accounts.map((account) =>
      resolveAccount(tx, userId, dataKey, connectionId, envelope.source, account),
    ),
  );
  const existing = await Promise.all(
    resolved.map((accountId) =>
      tx
        .select()
        .from(investmentSnapshotDetails)
        .where(
          and(
            eq(investmentSnapshotDetails.accountId, accountId),
            eq(investmentSnapshotDetails.weekStart, week),
          ),
        )
        .limit(1),
    ),
  );
  let unchanged = true;
  for (let index = 0; index < existing.length; index++) {
    const detail = existing[index][0];
    if (!detail) {
      unchanged = false;
      continue;
    }
    const evidence = await tx
      .select()
      .from(investmentSourceEvidence)
      .where(
        and(
          eq(investmentSourceEvidence.accountId, resolved[index]),
          eq(investmentSourceEvidence.sourceAsOf, sourceAsOf),
        ),
      )
      .limit(1);
    if (evidence.some((row) => Buffer.from(row.normalizedFingerprint).equals(fp))) continue;
    if (detail.sourceAsOf.getTime() > sourceAsOf.getTime()) fail("stale_source");
    unchanged = false;
  }
  let positions = 0;
  let cashBalances = 0;
  for (let index = 0; index < envelope.accounts.length; index++) {
    const account = envelope.accounts[index];
    const accountId = resolved[index];
    positions += account.positions.length;
    cashBalances += account.cash.length;
    if (!unchanged) {
      const old = existing[index][0];
      if (old) {
        await tx.delete(investmentSnapshotDetails).where(eq(investmentSnapshotDetails.id, old.id));
        await tx
          .delete(accountBalanceSnapshots)
          .where(eq(accountBalanceSnapshots.id, old.accountBalanceSnapshotId));
      }
      const componentIls: Decimal[] = [];
      const positionRows: Array<{
        position: (typeof account.positions)[number];
        instrumentId: string;
        value: string;
        currency: string;
        basis: "market_value" | "quantity_times_price";
      }> = [];
      for (const position of account.positions) {
        const value =
          position.sourceValue ??
          (position.sourcePrice
            ? new Decimal(position.quantity).mul(position.sourcePrice).toFixed()
            : undefined);
        if (!value && !new Decimal(position.quantity).isZero()) fail("unvalued_position");
        const valueCurrency =
          position.sourceValueCurrency ?? position.sourcePriceCurrency ?? position.currency;
        if (value)
          componentIls.push(
            new Decimal(value).mul(
              await ilsRate(
                tx,
                valueCurrency,
                sourceDate(position.sourceAsOf ?? envelope.sourceAsOf.value),
              ),
            ),
          );
        positionRows.push({
          position,
          instrumentId: await resolveInstrument(tx, userId, dataKey, envelope.source, position),
          value: value ?? "0",
          currency: valueCurrency,
          basis: position.sourceValue ? "market_value" : "quantity_times_price",
        });
      }
      for (const cash of account.cash)
        componentIls.push(
          new Decimal(cash.amount).mul(await ilsRate(tx, cash.currency, sourceAsOf)),
        );
      const totalIls = new Decimal(account.brokerTotal.amount).mul(
        await ilsRate(tx, account.brokerTotal.currency, sourceDate(account.brokerTotal.asOf)),
      );
      const reconciliationState = componentIls
        .reduce((total, item) => total.plus(item), new Decimal(0))
        .toDecimalPlaces(2)
        .eq(totalIls.toDecimalPlaces(2))
        ? "matched"
        : "mismatch";
      const parentId = randomUUID();
      const detailId = randomUUID();
      await tx.insert(accountBalanceSnapshots).values({
        id: parentId,
        ownerId: userId,
        accountId,
        date: calendarDate,
        nativeBalanceCt: null,
        currency: null,
        source: "investment",
      });
      await tx.insert(investmentSnapshotDetails).values({
        id: detailId,
        ownerId: userId,
        accountBalanceSnapshotId: parentId,
        accountId,
        connectionId,
        syncRunId,
        weekStart: week,
        source: envelope.source,
        sourceAsOf,
        sourceAsOfPrecision: envelope.sourceAsOf.precision,
        brokerTotalCt: encText(dataKey, account.brokerTotal.amount, detailId, "broker_total_ct", 1),
        brokerTotalCurrency: account.brokerTotal.currency,
        reconciliationState,
        validationVersion: 1,
      });
      for (const row of positionRows) {
        const id = randomUUID();
        const p = row.position;
        await tx.insert(investmentSnapshotPositions).values({
          id,
          ownerId: userId,
          snapshotId: detailId,
          instrumentId: row.instrumentId,
          quantityCt: encText(dataKey, p.quantity, id, "quantity_ct", 1),
          quantityUnit: p.quantityUnit,
          currency: p.currency,
          sourcePriceCt: p.sourcePrice
            ? encText(dataKey, p.sourcePrice, id, "source_price_ct", 1)
            : null,
          sourcePriceCurrency: p.sourcePriceCurrency ?? null,
          sourceValueCt: p.sourceValue
            ? encText(dataKey, p.sourceValue, id, "source_value_ct", 1)
            : null,
          sourceValueCurrency: p.sourceValueCurrency ?? null,
          sourceAsOf: p.sourceAsOf ? sourceDate(p.sourceAsOf) : null,
          brokerValuationBasis: row.basis,
        });
      }
      for (const cash of account.cash) {
        const id = randomUUID();
        await tx.insert(investmentSnapshotCashBalances).values({
          id,
          ownerId: userId,
          snapshotId: detailId,
          currency: cash.currency,
          amountCt: encText(dataKey, cash.amount, id, "amount_ct", 1),
        });
      }
    }
    await tx.insert(investmentSourceEvidence).values({
      id: randomUUID(),
      ownerId: userId,
      connectionId,
      syncRunId,
      accountId,
      source: envelope.source,
      sourceAsOf,
      sourceAsOfPrecision: envelope.sourceAsOf.precision,
      validationVersion: 1,
      positionRowCount: account.positions.length,
      cashRowCount: account.cash.length,
      qualityCodes: [],
      normalizedFingerprint: fp,
    });
  }
  const result = {
    outcome: unchanged ? ("unchanged" as const) : ("promoted" as const),
    accounts: envelope.accounts.length,
    positions,
    cashBalances,
  };
  await tx
    .update(connections)
    .set({ status: "active", lastSyncAt: new Date() })
    .where(eq(connections.id, connectionId));
  const transitioned = await tx
    .update(syncRuns)
    .set({
      status: "succeeded",
      windowEnd: new Date(),
      investmentSource: envelope.source,
      declaredAccountCount: result.accounts,
      promotedAccountCount: result.accounts,
      promotedPositionCount: result.positions,
      promotedCashBalanceCount: result.cashBalances,
    })
    .where(and(eq(syncRuns.id, syncRunId), eq(syncRuns.status, "running")))
    .returning({ id: syncRuns.id });
  if (transitioned.length !== 1) fail("invalid_sync");
  return result;
}

export async function promoteInvestmentSnapshot(input: {
  userId: string;
  connectionId: string;
  syncRunId: string;
  dataKey: Uint8Array;
  envelope: InvestmentSyncEnvelope;
}): Promise<InvestmentPromotionResult> {
  try {
    return await withUser(input.userId, (tx) => promote(tx, input));
  } catch (error) {
    const safe = error instanceof InvestmentPromotionError ? error.code : "invalid_sync";
    await markSyncRunFailed(input.userId, input.syncRunId, safe);
    throw error instanceof InvestmentPromotionError ? error : new InvestmentPromotionError(safe);
  }
}
