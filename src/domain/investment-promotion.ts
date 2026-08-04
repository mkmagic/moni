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
import { getConnectorDefinition } from "@/lib/connectors";
import { errorLabel, syncLog } from "@/lib/sync-log";
import { decText, encText } from "./fields";
import { israelDate } from "./investment-valuation";
import { markSyncRunFailed } from "./sync-promotion";

type Tx = UserTransaction;
type Source = InvestmentSyncEnvelope["source"];

export type InvestmentPromotionErrorCode =
  | "invalid_sync"
  | "promotion_failed"
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

/**
 * How far a broker's own FX rate may sit from BOI's before a cross-currency
 * holding stops reconciling — 0.5% of the converted amount.
 *
 * This is not a fudge factor for sloppy arithmetic; it is the width of a gap
 * that exists by construction. BOI publishes one representative rate per day,
 * fixed in the early afternoon Israel time, while a broker marks its NAV at
 * its own venue's close using its own rate. Two different sources, two
 * different moments on the same calendar day.
 *
 * Sized from live data: an IBKR account holding USD inside an ILS-based total
 * reconciled 6.2 bps apart, and 50 bps leaves room for an ordinary day's
 * USD/ILS move without hiding anything that matters — a genuinely missing
 * position lands in the thousands of bps.
 */
const FX_CROSS_SOURCE_TOLERANCE = new Decimal("0.005");

/**
 * Which revision of the reconciliation rules produced a stored verdict.
 *
 * `reconciliation_state` is a cached judgement, not observed data, so a
 * snapshot judged under older rules is stale even when the source re-serves a
 * byte-identical statement. Bump this whenever the verdict could change for
 * unchanged input, and the next sync recomputes instead of taking the
 * fingerprint-match fast path.
 *
 * 2 — cross-currency totals gained an FX allowance (FX_CROSS_SOURCE_TOLERANCE).
 */
const VALIDATION_VERSION = 2;

function fail(code: InvestmentPromotionErrorCode): never {
  throw new InvestmentPromotionError(code);
}

function sourceDate(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) fail("incomplete_coverage");
  return date;
}

/**
 * Half of the last digit a decimal actually reports — the most its rounding
 * can conceal. "368.21" could stand for anything in [368.205, 368.215), so it
 * hides at most 0.005.
 */
function halfUlp(value: string): Decimal {
  const decimals = value.split(".")[1]?.length ?? 0;
  return new Decimal(5).div(new Decimal(10).pow(decimals + 1));
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

/**
 * What the user calls this account. The source id ("snaptrade") is Moni's
 * plumbing, not a brokerage — an aggregator names the institution per account,
 * a direct connector is the institution.
 */
function institutionLabel(
  source: Source,
  account: InvestmentSyncEnvelope["accounts"][number],
): string {
  return account.institutionName ?? getConnectorDefinition(source)?.institutionLabel ?? source;
}

async function resolveAccount(
  tx: Tx,
  ownerId: string,
  dataKey: Uint8Array,
  connectionId: string,
  source: Source,
  account: InvestmentSyncEnvelope["accounts"][number],
): Promise<string> {
  const last4 = account.sourceAccountRef.slice(-4);
  const name = `${institutionLabel(source, account)} (${last4})`;
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
      // The institution is descriptive, not identity: a brokerage can rebrand,
      // and accounts created before Moni learned the real name are still
      // sitting on "snaptrade (EE23)". Re-derive it rather than stranding
      // them. Bumping the version re-keys every encrypted column on the row,
      // so all of them are rewritten together or the untouched ones stop
      // decrypting.
      if (decText(dataKey, row.nameCt, row.id, "name_ct", row.version) !== name) {
        const version = row.version + 1;
        // Carried across unchanged in value, but re-encrypted because the AAD
        // moved with the version.
        const carry = (value: Buffer | null, field: string) =>
          value
            ? encText(
                dataKey,
                decText(dataKey, value, row.id, field, row.version)!,
                row.id,
                field,
                version,
              )
            : null;
        await tx
          .update(accounts)
          .set({
            nameCt: encText(dataKey, name, row.id, "name_ct", version),
            accountNumberLast4Ct: encText(
              dataKey,
              last4,
              row.id,
              "account_number_last4_ct",
              version,
            ),
            externalAccountRefCt: encText(
              dataKey,
              account.sourceAccountRef,
              row.id,
              "external_account_ref_ct",
              version,
            ),
            currentBalanceCt: carry(row.currentBalanceCt, "current_balance_ct"),
            institution: institutionLabel(source, account),
            version,
          })
          .where(eq(accounts.id, row.id));
      }
      return row.id;
    }
  }
  const id = randomUUID();
  await tx.insert(accounts).values({
    id,
    ownerId,
    accountType: "investment",
    classification: "asset",
    connectionId,
    nameCt: encText(dataKey, name, id, "name_ct", 1),
    institution: institutionLabel(source, account),
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
    if (mapping.provider === source) {
      // Descriptive provider metadata, unlike the identity fields checked
      // above, can legitimately change between syncs — a venue relabelled, or
      // a MIC that Moni has since learned to translate. Valuation reads the
      // exchange only from here, so a stale one keeps a position permanently
      // and invisibly ineligible for a quote.
      const stored = (column: keyof typeof mapping, name: string) => {
        const value = mapping[column] as Buffer | null;
        return value ? decText(dataKey, value, mapping.id, name, mapping.version) : null;
      };
      if (
        stored("exchangeCt", "exchange_ct") !== (position.exchange ?? null) ||
        stored("providerSymbolCt", "provider_symbol_ct") !== (position.symbol ?? null) ||
        stored("providerNameCt", "provider_name_ct") !== (position.name ?? null)
      ) {
        // The row's version is the AAD for every encrypted column on it, so a
        // bump re-encrypts all of them together or the untouched ones stop
        // decrypting.
        const version = mapping.version + 1;
        const field = (value: string | undefined, name: string) =>
          value ? encText(dataKey, value, mapping.id, name, version) : null;
        await tx
          .update(instrumentSourceMappings)
          .set({
            providerIdentifierCt: encText(
              dataKey,
              position.sourceSecurityId,
              mapping.id,
              "provider_identifier_ct",
              version,
            ),
            providerSymbolCt: field(position.symbol, "provider_symbol_ct"),
            providerNameCt: field(position.name, "provider_name_ct"),
            exchangeCt: field(position.exchange, "exchange_ct"),
            version,
          })
          .where(eq(instrumentSourceMappings.id, mapping.id));
      }
    } else {
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

// BOI publishes a rate per Israeli calendar day, and every other investment
// date in the domain is bucketed with `israelDate` (investment-valuation.ts
// resolves FX for the same observation that way). Ceiling this lookup on the
// UTC date instead put an evening-UTC observation — 21:00–24:00Z, already the
// next day in Jerusalem — a day behind its own rate, so the only rate that
// could serve it sorted out of range.
async function ilsRate(tx: Tx, currency: string, asOf: Date): Promise<Decimal> {
  if (currency === "ILS") return new Decimal(1);
  const target = israelDate(asOf);
  const rows = await tx
    .select()
    .from(fxRates)
    .where(
      and(
        eq(fxRates.fromCurrency, currency),
        eq(fxRates.toCurrency, "ILS"),
        lte(fxRates.date, target),
      ),
    )
    .orderBy(desc(fxRates.date))
    .limit(1);
  const row = rows[0];
  if (
    !row ||
    row.source !== "boi" ||
    (Date.parse(`${target}T00:00:00Z`) - Date.parse(`${row.date}T00:00:00Z`)) / 86_400_000 > 7
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
  const resolved: string[] = [];
  for (const account of envelope.accounts)
    resolved.push(
      await resolveAccount(tx, userId, dataKey, connectionId, envelope.source, account),
    );
  const existing: Array<(typeof investmentSnapshotDetails.$inferSelect)[]> = [];
  for (const accountId of resolved)
    existing.push(
      await tx
        .select()
        .from(investmentSnapshotDetails)
        .where(
          and(
            eq(investmentSnapshotDetails.accountId, accountId),
            eq(investmentSnapshotDetails.weekStart, week),
          ),
        )
        .limit(1),
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
    // An identical statement is only genuinely "nothing to do" if the verdict
    // stored beside it was reached under the rules in force now. Otherwise a
    // rule fix would not reach an account until its broker happened to publish
    // something new — which for a Friday-dated statement means never, over a
    // weekend.
    if (
      detail.validationVersion === VALIDATION_VERSION &&
      evidence.some((row) => Buffer.from(row.normalizedFingerprint).equals(fp))
    )
      continue;
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
      // Zero whenever every position carried its own market value, which keeps
      // broker-valued sources on the exact comparison they have always had.
      let slackIls = new Decimal(0);
      // The ILS worth of everything held in a currency other than the one the
      // broker stated its total in. See FX_CROSS_SOURCE_TOLERANCE.
      let crossCurrencyIls = new Decimal(0);
      const crossCurrency = (currency: string, ils: Decimal) => {
        if (currency !== account.brokerTotal.currency)
          crossCurrencyIls = crossCurrencyIls.plus(ils.abs());
      };
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
        if (value) {
          const rate = await ilsRate(
            tx,
            valueCurrency,
            sourceDate(position.sourceAsOf ?? envelope.sourceAsOf.value),
          );
          componentIls.push(new Decimal(value).mul(rate));
          crossCurrency(valueCurrency, new Decimal(value).mul(rate));
          // A derived value can only be as exact as the price it was derived
          // from, so carry how much the broker's own rounding could hide.
          if (!position.sourceValue && position.sourcePrice)
            slackIls = slackIls.plus(
              new Decimal(position.quantity).abs().mul(halfUlp(position.sourcePrice)).mul(rate),
            );
        }
        positionRows.push({
          position,
          instrumentId: await resolveInstrument(tx, userId, dataKey, envelope.source, position),
          value: value ?? "0",
          currency: valueCurrency,
          basis: position.sourceValue ? "market_value" : "quantity_times_price",
        });
      }
      for (const cash of account.cash) {
        const ils = new Decimal(cash.amount).mul(await ilsRate(tx, cash.currency, sourceAsOf));
        componentIls.push(ils);
        crossCurrency(cash.currency, ils);
      }
      const totalRate = await ilsRate(
        tx,
        account.brokerTotal.currency,
        sourceDate(account.brokerTotal.asOf),
      );
      const totalIls = new Decimal(account.brokerTotal.amount).mul(totalRate);
      if (slackIls.isPositive())
        slackIls = slackIls.plus(halfUlp(account.brokerTotal.amount).mul(totalRate));
      // A cross-currency holding is the one place the two sides of this
      // comparison were not built by the same arithmetic: the broker converted
      // it with its own rate at its own mark time, Moni converts it with BOI's
      // representative rate. Demanding they agree exactly asks two independent
      // FX authorities to publish the same number, so this account would report
      // "mismatch" on every sync forever.
      const fxSlackIls = crossCurrencyIls.mul(FX_CROSS_SOURCE_TOLERANCE);
      slackIls = slackIls.plus(fxSlackIls);
      const componentSum = componentIls
        .reduce((total, item) => total.plus(item), new Decimal(0))
        .toDecimalPlaces(2);
      const delta = componentSum.minus(totalIls.toDecimalPlaces(2));
      const reconciliationState = delta.abs().lte(slackIls.toDecimalPlaces(2))
        ? "matched"
        : "mismatch";
      // Deliberately relative, not absolute: basis points say whether a
      // mismatch is an FX spread (tens of bps, because the broker converted
      // its own NAV at its own rate while Moni converts components at BOI's)
      // or a genuinely missing component (thousands) — without putting the
      // portfolio's value in a log line.
      syncLog("promotion.reconciliation", {
        source: envelope.source,
        state: reconciliationState,
        totalCurrency: account.brokerTotal.currency,
        componentCurrencies: [
          ...new Set([
            ...positionRows.map((row) => row.currency),
            ...account.cash.map((cash) => cash.currency),
          ]),
        ]
          .sort()
          .join(","),
        deltaBps: totalIls.isZero()
          ? null
          : delta.div(totalIls).mul(10_000).toDecimalPlaces(1).toFixed(),
        slackBps: totalIls.isZero()
          ? null
          : slackIls.div(totalIls).mul(10_000).toDecimalPlaces(1).toFixed(),
        // Split out so a mismatch says which allowance was too small.
        fxSlackBps: totalIls.isZero()
          ? null
          : fxSlackIls.div(totalIls).mul(10_000).toDecimalPlaces(1).toFixed(),
      });
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
        validationVersion: VALIDATION_VERSION,
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
      validationVersion: VALIDATION_VERSION,
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
  // "unchanged" is the state that looked exactly like a failed sync from the
  // UI: the run succeeds, the counts are non-zero, and yet not a single row
  // moves because the source re-served an identical statement.
  syncLog("promotion.outcome", {
    source: envelope.source,
    outcome: result.outcome,
    sourceAsOf: envelope.sourceAsOf.value,
    weekStart: week,
    accounts: result.accounts,
    positions: result.positions,
    cashBalances: result.cashBalances,
  });
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
    // `invalid_sync` is a specific rejection (the run or connection did not
    // match the envelope). Anything else reaching here is an unexpected
    // exception and must not borrow that code, or a database fault reads as a
    // deliberate guard.
    const promotion = error instanceof InvestmentPromotionError;
    syncLog("promotion.failed", {
      source: input.envelope.source,
      code: promotion ? error.code : "promotion_failed",
      error: promotion ? undefined : errorLabel(error),
    });
    if (!promotion) reportPromotionFault(error);
    const safe = promotion ? error.code : "promotion_failed";
    await markSyncRunFailed(input.userId, input.syncRunId, safe);
    throw promotion ? error : new InvestmentPromotionError(safe);
  }
}

/**
 * Opt-in fault report (MONI_SYNC_DIAGNOSTIC=1) for an exception the promotion
 * path did not expect. Prints the error's identity and Postgres's structural
 * fields only — never `detail`, which quotes offending row values and would
 * put ciphertext or an account reference in the log.
 */
function reportPromotionFault(error: unknown): void {
  if (process.env.MONI_SYNC_DIAGNOSTIC !== "1") return;
  const lines: string[] = [];
  // Drizzle wraps the driver error, so the Postgres fields that actually name
  // the fault live on `cause`. Without walking the chain the report stops at
  // "Failed query: ..." and says nothing about why it failed.
  let current: unknown = error;
  for (let depth = 0; current != null && depth < 5; depth += 1) {
    const fault = current as { message?: unknown } & Record<string, unknown>;
    const fields = ["code", "constraint", "table", "column", "dataType", "schema", "routine"]
      .map((key) => (fault[key] == null ? null : `${key}=${String(fault[key])}`))
      .filter(Boolean);
    lines.push(
      `${depth === 0 ? "promotion diagnostic" : `  caused by`}: ` +
        `${current instanceof Error ? current.name : typeof current}: ` +
        `${String(fault.message ?? current).split("\n")[0]}`,
    );
    if (fields.length) lines.push(`    postgres: ${fields.join(" ")}`);
    current = (fault as { cause?: unknown }).cause;
  }
  console.error(lines.join("\n"));
}
