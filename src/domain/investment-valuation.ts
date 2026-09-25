import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { withUser, type UserTransaction } from "@/db/client";
import {
  accounts,
  fxRates,
  instrumentSourceMappings,
  instruments,
  investmentMarketQuotes,
  investmentActivityCoverage,
  investmentActivityEvidence,
  investmentCorporateActionEvidence,
  investmentDisposalResolutionQueue,
  investmentOpeningCashEvidence,
  investmentReconciliationQuality,
  investmentSnapshotCashBalances,
  investmentSnapshotDetails,
  investmentSnapshotPositions,
  investmentTaxLots,
} from "@/db/schema";
import { syncLog } from "@/lib/sync-log";
import { decText, encText } from "./fields";
import { BROKER_ELSE_USER_POLICY_VERSION } from "./investment-lots";

export type ValuationBasis = "broker_source" | "tiingo_estimate" | "mixed";
export type ValuationFreshness = "current" | "stale" | "mixed_age";
export type ValuationQualityFlag =
  "carried_forward" | "quote_fallback" | "reconciliation_mismatch" | "incomplete_fx";

export interface ValuationMetadata {
  basis: ValuationBasis;
  freshness: ValuationFreshness;
  sourceAsOf: string | null;
  quoteAsOf: string | null;
  fxAsOf: string | null;
  oldestComponentDate: string | null;
  affectedComponentCount: number;
  qualityFlags: ValuationQualityFlag[];
}

export interface InvestmentValuation {
  ilsValue: string;
  nativeValue: string | null;
  currency: string | null;
  metadata: ValuationMetadata;
}

export interface InvestmentNetWorth {
  ilsValue: string;
  metadata: ValuationMetadata;
}

/** Shared internal quote-or-broker decision; it is deliberately pure and has no I/O. */
export function selectCurrentComponent(input: {
  estimateNow: boolean;
  now: Date;
  kind: string | undefined;
  positionCurrency: string;
  mappingCurrency: string | undefined;
  exchange: string | null;
  quantity: string;
  brokerValue: string;
  brokerCurrency: string;
  brokerDate: Date;
  quote?: {
    price: string;
    currency: string;
    sourceDate: string;
    qualityState: string;
    splitState: string;
  };
}): {
  value: string;
  currency: string;
  date: Date;
  basis: "broker_source" | "tiingo_estimate";
  quoteDate: string | null;
  fallback: boolean;
  /** Null when a quote was used. Otherwise the first rule the quote failed. */
  fallbackReason: string | null;
} {
  const quote = input.quote;
  const quoteDate = quote ? new Date(`${quote.sourceDate}T00:00:00Z`) : null;
  // Ordered so the first failing rule is the one reported, which makes
  // "quote fallback" in the UI traceable to a single named condition.
  const reason = !input.estimateNow
    ? "estimates_not_requested"
    : input.kind !== "stock" && input.kind !== "etf"
      ? "kind_not_quotable"
      : input.positionCurrency !== "USD" || input.mappingCurrency !== "USD"
        ? "currency_not_usd"
        : input.exchange !== "NYSE" && input.exchange !== "NASDAQ"
          ? "exchange_not_eligible"
          : !quote || !quoteDate
            ? "no_quote"
            : quote.currency !== "USD"
              ? "quote_currency_not_usd"
              : quote.qualityState !== "accepted"
                ? "quote_not_accepted"
                : quote.splitState !== "safe" &&
                    !(quote.splitState === "post_split" && quoteDate <= input.brokerDate)
                  ? "split_unsafe"
                  : !withinSevenDays(quote.sourceDate, input.now)
                    ? "quote_older_than_seven_days"
                    : input.brokerDate.getTime() > quoteDate.getTime() + DAY
                      ? "broker_value_is_newer"
                      : null;
  if (reason === null && quote && quoteDate)
    return {
      value: new Decimal(input.quantity).mul(quote.price).toFixed(),
      currency: "USD",
      date: quoteDate,
      basis: "tiingo_estimate",
      quoteDate: quote.sourceDate,
      fallback: false,
      fallbackReason: null,
    };
  return {
    value: input.brokerValue,
    currency: input.brokerCurrency,
    date: input.brokerDate,
    basis: "broker_source",
    quoteDate: null,
    fallback: input.estimateNow,
    fallbackReason: reason,
  };
}

type Tx = UserTransaction;
const DAY = 86_400_000;

export function israelDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function israelWeekStart(date: Date | string): string {
  const day = typeof date === "string" ? date : israelDate(date);
  const value = new Date(`${day}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - value.getUTCDay());
  return value.toISOString().slice(0, 10);
}

function dateAtMidnight(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

function currentBrokerWeek(now: Date, source: Date): boolean {
  const current = dateAtMidnight(israelDate(now));
  const observed = dateAtMidnight(israelDate(source));
  const currentSunday = new Date(current.getTime() - current.getUTCDay() * DAY);
  return observed.getTime() >= currentSunday.getTime() - 7 * DAY;
}

function withinSevenDays(date: string, now: Date): boolean {
  const age = (dateAtMidnight(israelDate(now)).getTime() - dateAtMidnight(date).getTime()) / DAY;
  return age >= 0 && age <= 7;
}

async function fx(
  tx: Tx,
  currency: string,
  asOf: Date,
): Promise<{ rate: Decimal; date: string } | null> {
  if (currency === "ILS") return { rate: new Decimal(1), date: israelDate(asOf) };
  const target = israelDate(asOf);
  const [row] = await tx
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
  if (!row || row.source !== "boi" || !withinSevenDays(row.date, asOf)) return null;
  return { rate: new Decimal(row.rate), date: row.date };
}

function emptyMetadata(): ValuationMetadata {
  return {
    basis: "broker_source",
    freshness: "current",
    sourceAsOf: null,
    quoteAsOf: null,
    fxAsOf: null,
    oldestComponentDate: null,
    affectedComponentCount: 0,
    qualityFlags: [],
  };
}

/**
 * Internal, RLS-scoped valuation seam. It deliberately receives a transaction
 * and never imports a provider adapter or fetch implementation.
 */
export async function valueInvestmentSnapshot(
  tx: Tx,
  dataKey: Uint8Array,
  snapshotId: string,
  options: { estimateNow?: boolean; now?: Date } = {},
): Promise<InvestmentValuation> {
  const now = options.now ?? new Date();
  const [detail] = await tx
    .select()
    .from(investmentSnapshotDetails)
    .where(eq(investmentSnapshotDetails.id, snapshotId))
    .limit(1);
  if (!detail) throw new Error("investment snapshot not found");
  const positions = await tx
    .select()
    .from(investmentSnapshotPositions)
    .where(eq(investmentSnapshotPositions.snapshotId, detail.id));
  const cash = await tx
    .select()
    .from(investmentSnapshotCashBalances)
    .where(eq(investmentSnapshotCashBalances.snapshotId, detail.id));
  const quoteRows = await tx.select().from(investmentMarketQuotes);
  const mappingRows = await tx.select().from(instrumentSourceMappings);
  const quoteByInstrument = new Map(
    quoteRows.filter((row) => row.provider === "tiingo").map((row) => [row.instrumentId, row]),
  );
  const mappingsByInstrument = new Map<string, (typeof mappingRows)[number]>();
  for (const mapping of mappingRows)
    if (!mappingsByInstrument.has(mapping.instrumentId))
      mappingsByInstrument.set(mapping.instrumentId, mapping);
  const instrumentRows = await tx.select().from(instruments);
  const instrumentsById = new Map(instrumentRows.map((row) => [row.id, row]));
  let ils = new Decimal(0);
  const nativeByCurrency = new Map<string, Decimal>();
  let anyTiingo = false;
  let anyBroker = false;
  let fallback = 0;
  let incompleteFx = 0;
  const sourceDates: string[] = [];
  const quoteDates: string[] = [];
  const fxDates: string[] = [];
  const qualities = new Set<ValuationQualityFlag>();
  if (detail.reconciliationState === "mismatch") qualities.add("reconciliation_mismatch");

  for (const position of positions) {
    const quantity = decText(
      dataKey,
      position.quantityCt,
      position.id,
      "quantity_ct",
      position.version,
    )!;
    const sourceValue = decText(
      dataKey,
      position.sourceValueCt,
      position.id,
      "source_value_ct",
      position.version,
    );
    const sourcePrice = decText(
      dataKey,
      position.sourcePriceCt,
      position.id,
      "source_price_ct",
      position.version,
    );
    const sourceDate = position.sourceAsOf ?? detail.sourceAsOf;
    const sourceCurrency =
      position.sourceValueCurrency ?? position.sourcePriceCurrency ?? position.currency;
    let value =
      sourceValue ?? (sourcePrice ? new Decimal(quantity).mul(sourcePrice).toFixed() : "0");
    const quote = quoteByInstrument.get(position.instrumentId);
    const mapping = mappingsByInstrument.get(position.instrumentId);
    const instrument = instrumentsById.get(position.instrumentId);
    const exchange = mapping?.exchangeCt
      ? (decText(
          dataKey,
          mapping.exchangeCt,
          mapping.id,
          "exchange_ct",
          mapping.version,
        )?.toUpperCase() ?? null)
      : null;
    const selected = selectCurrentComponent({
      estimateNow: !!options.estimateNow,
      now,
      kind: instrument?.kind,
      positionCurrency: position.currency,
      mappingCurrency: mapping?.currency,
      exchange,
      quantity,
      brokerValue: value,
      brokerCurrency: sourceCurrency,
      brokerDate: sourceDate,
      quote: quote
        ? {
            price: decText(dataKey, quote.priceCt, quote.id, "price_ct", quote.version)!,
            currency: quote.currency,
            sourceDate: quote.sourceDate,
            qualityState: quote.qualityState,
            splitState: quote.splitState,
          }
        : undefined,
    });
    value = selected.value;
    const currency = selected.currency;
    const usedTiingo = selected.basis === "tiingo_estimate";
    if (usedTiingo) {
      quoteDates.push(selected.quoteDate!);
      anyTiingo = true;
    } else if (selected.fallback) {
      fallback += 1;
      qualities.add("quote_fallback");
      syncLog("valuation.quote_fallback", {
        instrumentId: position.instrumentId,
        reason: selected.fallbackReason,
        exchange,
        brokerDate: israelDate(sourceDate),
        quoteDate: quote?.sourceDate,
      });
    }
    if (!usedTiingo) anyBroker = true;
    nativeByCurrency.set(currency, (nativeByCurrency.get(currency) ?? new Decimal(0)).plus(value));
    const rate = await fx(tx, currency, selected.date);
    if (!rate) {
      incompleteFx += 1;
      qualities.add("incomplete_fx");
      continue;
    }
    ils = ils.plus(new Decimal(value).mul(rate.rate));
    sourceDates.push(israelDate(sourceDate));
    fxDates.push(rate.date);
  }
  for (const row of cash) {
    const amount = decText(dataKey, row.amountCt, row.id, "amount_ct", row.version)!;
    nativeByCurrency.set(
      row.currency,
      (nativeByCurrency.get(row.currency) ?? new Decimal(0)).plus(amount),
    );
    const rate = await fx(tx, row.currency, detail.sourceAsOf);
    if (!rate) {
      incompleteFx += 1;
      qualities.add("incomplete_fx");
      continue;
    }
    ils = ils.plus(new Decimal(amount).mul(rate.rate));
    sourceDates.push(israelDate(detail.sourceAsOf));
    fxDates.push(rate.date);
  }
  const allDates = [...sourceDates, ...quoteDates, ...fxDates].sort();
  const sourceAsOf = sourceDates.sort().at(-1) ?? null;
  const quoteAsOf = quoteDates.sort().at(-1) ?? null;
  const fxAsOf = fxDates.sort().at(-1) ?? null;
  const native = nativeByCurrency.size === 1 ? [...nativeByCurrency.entries()][0] : null;
  return {
    ilsValue: ils.toFixed(),
    nativeValue: native?.[1].toFixed() ?? null,
    currency: native?.[0] ?? null,
    metadata: {
      basis: anyTiingo ? (anyBroker ? "mixed" : "tiingo_estimate") : "broker_source",
      freshness: currentBrokerWeek(now, detail.sourceAsOf)
        ? quoteDates.length && sourceDates.length && sourceAsOf !== quoteAsOf
          ? "mixed_age"
          : "current"
        : "stale",
      sourceAsOf,
      quoteAsOf,
      fxAsOf,
      oldestComponentDate: allDates[0] ?? null,
      affectedComponentCount:
        fallback + incompleteFx + (detail.reconciliationState === "mismatch" ? 1 : 0),
      qualityFlags: [...qualities].sort(),
    },
  };
}

/**
 * Internal dashboard seam.  It intentionally shares the per-component valuation
 * engine above so current estimates and durable broker history cannot diverge.
 */
export async function valueInvestmentNetWorth(
  tx: Tx,
  dataKey: Uint8Array,
  options: { now?: Date; cutoff?: string } = {},
): Promise<InvestmentNetWorth> {
  const now = options.now ?? new Date();
  const cutoff = options.cutoff;
  const accountRows = await tx.select().from(accounts);
  const detailRows = await tx.select().from(investmentSnapshotDetails);
  const selected: Array<{ id: string; carried: boolean }> = [];
  for (const account of accountRows) {
    if (account.accountType !== "investment") continue;
    const point = cutoff ?? israelDate(now);
    if (account.archivedAt && israelDate(account.archivedAt) <= point) continue;
    if (!cutoff && account.status !== "active") continue;
    const candidates = detailRows.filter(
      (detail) =>
        detail.accountId === account.id && (!cutoff || israelDate(detail.sourceAsOf) <= cutoff),
    );
    const detail = candidates.sort((a, b) => b.sourceAsOf.getTime() - a.sourceAsOf.getTime())[0];
    if (detail)
      selected.push({
        id: detail.id,
        carried: !!cutoff && detail.weekStart < israelWeekStart(cutoff),
      });
  }
  const values: InvestmentValuation[] = [];
  for (const { id, carried } of selected) {
    const value = await valueInvestmentSnapshot(tx, dataKey, id, {
      now,
      estimateNow: !cutoff,
    });
    values.push(
      carried
        ? {
            ...value,
            metadata: {
              ...value.metadata,
              freshness: "stale" as const,
              affectedComponentCount: value.metadata.affectedComponentCount + 1,
              qualityFlags: [
                ...new Set([...value.metadata.qualityFlags, "carried_forward" as const]),
              ].sort(),
            },
          }
        : value,
    );
  }
  const flags = new Set<ValuationQualityFlag>();
  values.forEach((value) => value.metadata.qualityFlags.forEach((flag) => flags.add(flag)));
  const dates = (
    key: keyof Pick<
      ValuationMetadata,
      "sourceAsOf" | "quoteAsOf" | "fxAsOf" | "oldestComponentDate"
    >,
  ) =>
    values
      .map((value) => value.metadata[key])
      .filter((value): value is string => value !== null)
      .sort();
  const freshnesses = values.map((value) => value.metadata.freshness);
  return {
    ilsValue: values.reduce((sum, value) => sum.plus(value.ilsValue), new Decimal(0)).toFixed(),
    metadata: {
      basis: values.every((value) => value.metadata.basis === "broker_source")
        ? "broker_source"
        : values.every((value) => value.metadata.basis === "tiingo_estimate")
          ? "tiingo_estimate"
          : "mixed",
      freshness:
        freshnesses.includes("mixed_age") ||
        (freshnesses.includes("current") && freshnesses.includes("stale"))
          ? "mixed_age"
          : freshnesses.includes("stale")
            ? "stale"
            : "current",
      sourceAsOf: dates("sourceAsOf").at(-1) ?? null,
      quoteAsOf: dates("quoteAsOf").at(-1) ?? null,
      fxAsOf: dates("fxAsOf").at(-1) ?? null,
      oldestComponentDate: dates("oldestComponentDate")[0] ?? null,
      affectedComponentCount: values.reduce(
        (sum, value) => sum + value.metadata.affectedComponentCount,
        0,
      ),
      qualityFlags: [...flags].sort(),
    },
  };
}

/** Internal worker seam: target discovery is RLS-scoped and never performs network I/O. */
export async function listTiingoQuoteTargets(
  tx: Tx,
  dataKey: Uint8Array,
): Promise<TiingoQuoteTarget[]> {
  const details = await tx.select().from(investmentSnapshotDetails);
  const accountRows = await tx.select().from(accounts);
  const positions = await tx.select().from(investmentSnapshotPositions);
  const mappingRows = await tx.select().from(instrumentSourceMappings);
  const instrumentRows = await tx.select().from(instruments);
  const active = new Set(
    accountRows
      .filter((row) => row.archivedAt === null && row.status === "active")
      .map((row) => row.id),
  );
  const latest = new Map<string, (typeof details)[number]>();
  for (const detail of details)
    if (
      active.has(detail.accountId) &&
      (!latest.get(detail.accountId) ||
        latest.get(detail.accountId)!.sourceAsOf < detail.sourceAsOf)
    )
      latest.set(detail.accountId, detail);
  const snapshots = new Set([...latest.values()].map((detail) => detail.id));
  const instrumentById = new Map(instrumentRows.map((row) => [row.id, row]));
  const result = new Map<string, TiingoQuoteTarget>();
  for (const position of [...positions].sort((a, b) =>
    a.instrumentId.localeCompare(b.instrumentId),
  )) {
    if (!snapshots.has(position.snapshotId)) continue;
    // Every `continue` below silently costs a holding its quote. Naming the
    // reason is the only way to tell "Tiingo is broken" from "this holding was
    // never eligible" — the exact confusion that hid the missing IBKR
    // exchange for as long as it did.
    const skip = (reason: string, detail?: Record<string, string | null | undefined>) =>
      syncLog("quotes.target.skipped", {
        instrumentId: position.instrumentId,
        reason,
        ...detail,
      });
    if (position.currency !== "USD") {
      skip("currency_not_usd", { currency: position.currency });
      continue;
    }
    const instrument = instrumentById.get(position.instrumentId);
    if (!instrument || (instrument.kind !== "stock" && instrument.kind !== "etf")) {
      skip("kind_not_quotable", { kind: instrument?.kind });
      continue;
    }
    const candidates = mappingRows.filter(
      (row) => row.instrumentId === position.instrumentId && row.provider !== "tiingo",
    );
    const mapping = candidates
      .filter((row) => row.currency === "USD" && row.providerSymbolCt && row.exchangeCt)
      .sort((a, b) => a.id.localeCompare(b.id))[0];
    if (!mapping) {
      skip("no_usable_source_mapping", {
        providers: candidates.map((row) => row.provider).join(",") || null,
        // The IBKR normalizer read the wrong XML attribute and left this null,
        // which made the holding permanently unquotable and invisibly so.
        missing: candidates.every((row) => !row.exchangeCt)
          ? "exchange"
          : candidates.every((row) => !row.providerSymbolCt)
            ? "symbol"
            : "currency",
      });
      continue;
    }
    const exchange = decText(
      dataKey,
      mapping.exchangeCt,
      mapping.id,
      "exchange_ct",
      mapping.version,
    )?.toUpperCase();
    const symbol = decText(
      dataKey,
      mapping.providerSymbolCt,
      mapping.id,
      "provider_symbol_ct",
      mapping.version,
    );
    if ((exchange !== "NYSE" && exchange !== "NASDAQ") || !symbol) {
      skip(symbol ? "exchange_not_eligible" : "no_symbol", { exchange });
      continue;
    }
    if (!result.has(instrument.id))
      result.set(instrument.id, { instrumentId: instrument.id, mappingId: mapping.id, symbol });
  }
  return [...result.values()];
}

/** The only Tiingo quote write path. One current quote replaces the prior provider quote. */
export async function replaceTiingoQuote(
  tx: Tx,
  dataKey: Uint8Array,
  input: TiingoQuoteTarget & {
    price: string;
    sourceDate: string;
    fetchedAt: Date;
    splitState: "safe" | "post_split" | "unknown";
    qualityState: "accepted" | "stale";
  },
): Promise<void> {
  const [sourceMapping] = await tx
    .select()
    .from(instrumentSourceMappings)
    .where(eq(instrumentSourceMappings.id, input.mappingId))
    .limit(1);
  const [instrument] = await tx
    .select()
    .from(instruments)
    .where(eq(instruments.id, input.instrumentId))
    .limit(1);
  if (
    !sourceMapping ||
    !instrument ||
    sourceMapping.instrumentId !== input.instrumentId ||
    sourceMapping.ownerId !== instrument.ownerId ||
    sourceMapping.currency !== "USD" ||
    sourceMapping.provider === "tiingo"
  )
    throw new Error("Tiingo source mapping not found");
  let [tiingoMapping] = await tx
    .select()
    .from(instrumentSourceMappings)
    .where(
      and(
        eq(instrumentSourceMappings.instrumentId, input.instrumentId),
        eq(instrumentSourceMappings.provider, "tiingo"),
      ),
    )
    .limit(1);
  if (!tiingoMapping) {
    const id = randomUUID();
    const exchange = sourceMapping.exchangeCt
      ? decText(
          dataKey,
          sourceMapping.exchangeCt,
          sourceMapping.id,
          "exchange_ct",
          sourceMapping.version,
        )
      : null;
    await tx.insert(instrumentSourceMappings).values({
      id,
      ownerId: sourceMapping.ownerId,
      instrumentId: input.instrumentId,
      provider: "tiingo",
      identifierKind: "tiingo_symbol",
      providerIdentifierCt: encText(dataKey, input.symbol, id, "provider_identifier_ct", 1),
      providerSymbolCt: encText(dataKey, input.symbol, id, "provider_symbol_ct", 1),
      providerNameCt: null,
      exchangeCt: exchange ? encText(dataKey, exchange, id, "exchange_ct", 1) : null,
      currency: "USD",
      version: 1,
    });
    [tiingoMapping] = await tx
      .select()
      .from(instrumentSourceMappings)
      .where(eq(instrumentSourceMappings.id, id))
      .limit(1);
  }
  const [existing] = await tx
    .select()
    .from(investmentMarketQuotes)
    .where(
      and(
        eq(investmentMarketQuotes.instrumentId, input.instrumentId),
        eq(investmentMarketQuotes.provider, "tiingo"),
      ),
    )
    .limit(1);
  const id = existing?.id ?? randomUUID();
  const values = {
    instrumentSourceMappingId: tiingoMapping!.id,
    providerSymbolCt: encText(dataKey, input.symbol, id, "provider_symbol_ct", 1),
    priceCt: encText(dataKey, input.price, id, "price_ct", 1),
    currency: "USD",
    sourceDate: input.sourceDate,
    fetchedAt: input.fetchedAt,
    splitState: input.splitState,
    qualityState: input.qualityState,
  };
  if (existing)
    await tx.update(investmentMarketQuotes).set(values).where(eq(investmentMarketQuotes.id, id));
  else
    await tx.insert(investmentMarketQuotes).values({
      id,
      ownerId: (
        await tx
          .select({ ownerId: instruments.ownerId })
          .from(instruments)
          .where(eq(instruments.id, input.instrumentId))
          .limit(1)
      )[0]!.ownerId,
      instrumentId: input.instrumentId,
      provider: "tiingo",
      version: 1,
      ...values,
    });
}

/** Worker-facing domain reads keep child processes out of the database layer. */
export function listTiingoQuoteTargetsForUser(userId: string, dataKey: Uint8Array) {
  return withUser(userId, (tx) => listTiingoQuoteTargets(tx, dataKey));
}

/** Worker-facing domain write for one accepted, user-owned Tiingo observation. */
export function replaceTiingoQuoteForUser(
  userId: string,
  dataKey: Uint8Array,
  input: TiingoQuoteTarget & {
    price: string;
    sourceDate: string;
    fetchedAt: Date;
    splitState: "safe" | "post_split" | "unknown";
    qualityState: "accepted" | "stale";
  },
) {
  return withUser(userId, (tx) => replaceTiingoQuote(tx, dataKey, input));
}

export function tiingoWorkerConfiguration(
  env: { MONI_TIINGO_MULTI_USER_AUTHORIZED?: string; MONI_TIINGO_TOKEN?: string } = process.env as {
    MONI_TIINGO_MULTI_USER_AUTHORIZED?: string;
    MONI_TIINGO_TOKEN?: string;
  },
): Buffer | null {
  if (env.MONI_TIINGO_MULTI_USER_AUTHORIZED !== "true" || !env.MONI_TIINGO_TOKEN) return null;
  return Buffer.from(env.MONI_TIINGO_TOKEN, "utf8");
}

export interface TiingoQuoteTarget {
  instrumentId: string;
  mappingId: string;
  symbol: string;
}

type ReconciliationDimension =
  | "position_quantity"
  | "cash_balance"
  | "coverage_start"
  | "unexplained_opening_quantity"
  | "unsupported_corporate_action"
  | "pending_activity";

/** Historical snapshot warnings remain evidence, not current review items.
 * Also handles records left pending by older reconciliation implementations. */
export function currentReconciliationSnapshot() {
  return eq(
    investmentReconciliationQuality.snapshotId,
    sql`(
    select ${investmentSnapshotDetails.id} from ${investmentSnapshotDetails}
    where ${investmentSnapshotDetails.accountId} = ${investmentReconciliationQuality.accountId}
    order by ${investmentSnapshotDetails.sourceAsOf} desc
    limit 1
  )`,
  );
}

interface ReconciliationGap {
  dimension: ReconciliationDimension;
  instrumentId: string | null;
  currency: string | null;
  expected: string | null;
  observed: string | null;
  details: string;
}

interface ReconciliationInternalInput extends InvestmentActivityReconciliationInput {
  policyVersion: string;
}

export interface InvestmentActivityReconciliationInput {
  userId: string;
  accountId: string;
  snapshotId?: string;
  policyVersion?: string;
  /** Tier-1 data key. The caller owns its lifetime and wiping. */
  dataKey: Uint8Array;
}

export interface InvestmentActivityReconciliationResult {
  snapshotId: string;
  gaps: number;
  affectedInstrumentIds: string[];
}

function reconciliationKey(row: {
  dimension: ReconciliationDimension;
  instrumentId: string | null;
  currency: string | null;
}): string {
  return `${row.dimension}:${row.instrumentId ?? ""}:${row.currency ?? ""}`;
}

async function reconcileInvestmentActivityInTransaction(
  tx: Tx,
  input: ReconciliationInternalInput,
): Promise<InvestmentActivityReconciliationResult> {
  const details = input.snapshotId
    ? await tx
        .select()
        .from(investmentSnapshotDetails)
        .where(
          and(
            eq(investmentSnapshotDetails.id, input.snapshotId),
            eq(investmentSnapshotDetails.accountId, input.accountId),
          ),
        )
        .limit(1)
    : await tx
        .select()
        .from(investmentSnapshotDetails)
        .where(eq(investmentSnapshotDetails.accountId, input.accountId))
        .orderBy(desc(investmentSnapshotDetails.sourceAsOf))
        .limit(1);
  const detail = details[0];
  if (!detail) throw new Error("investment snapshot not found");

  const positions = await tx
    .select()
    .from(investmentSnapshotPositions)
    .where(eq(investmentSnapshotPositions.snapshotId, detail.id));
  const snapshotCash = await tx
    .select()
    .from(investmentSnapshotCashBalances)
    .where(eq(investmentSnapshotCashBalances.snapshotId, detail.id));
  const lots = await tx
    .select()
    .from(investmentTaxLots)
    .where(
      and(
        eq(investmentTaxLots.accountId, input.accountId),
        eq(investmentTaxLots.policyVersion, input.policyVersion),
      ),
    );
  const activities = await tx
    .select()
    .from(investmentActivityEvidence)
    .where(eq(investmentActivityEvidence.accountId, input.accountId));
  const openingCash = await tx
    .select()
    .from(investmentOpeningCashEvidence)
    .where(eq(investmentOpeningCashEvidence.accountId, input.accountId));
  const coverage = await tx
    .select()
    .from(investmentActivityCoverage)
    .where(eq(investmentActivityCoverage.accountId, input.accountId));
  const corporateActions = await tx
    .select()
    .from(investmentCorporateActionEvidence)
    .where(eq(investmentCorporateActionEvidence.accountId, input.accountId));
  const pendingQueue = await tx
    .select()
    .from(investmentDisposalResolutionQueue)
    .where(
      and(
        eq(investmentDisposalResolutionQueue.accountId, input.accountId),
        eq(investmentDisposalResolutionQueue.status, "pending"),
      ),
    );

  const snapshotQuantities = new Map<string, { quantity: Decimal; unit: string }>();
  for (const position of positions) {
    const quantity = decText(
      input.dataKey,
      position.quantityCt,
      position.id,
      "quantity_ct",
      position.version,
    )!;
    snapshotQuantities.set(position.instrumentId, {
      quantity: new Decimal(quantity),
      unit: position.quantityUnit,
    });
  }
  const derivedQuantities = new Map<string, { quantity: Decimal; unit: string }>();
  for (const lot of lots) {
    const quantity = decText(
      input.dataKey,
      lot.remainingQuantityCt,
      lot.id,
      "remaining_quantity_ct",
      lot.version,
    )!;
    const current = derivedQuantities.get(lot.instrumentId);
    derivedQuantities.set(lot.instrumentId, {
      quantity: (current?.quantity ?? new Decimal(0)).plus(quantity),
      unit: current?.unit ?? lot.quantityUnit,
    });
  }

  const gaps: ReconciliationGap[] = [];
  const instrumentsToCompare = new Set([...snapshotQuantities.keys(), ...derivedQuantities.keys()]);
  for (const instrumentId of instrumentsToCompare) {
    const expected = snapshotQuantities.get(instrumentId);
    const observed = derivedQuantities.get(instrumentId);
    const expectedQuantity = expected?.quantity ?? new Decimal(0);
    const observedQuantity = observed?.quantity ?? new Decimal(0);
    if (expectedQuantity.equals(observedQuantity) && expected?.unit === observed?.unit) continue;
    gaps.push({
      dimension: "position_quantity",
      instrumentId,
      currency: null,
      expected: expectedQuantity.toFixed(),
      observed: observedQuantity.toFixed(),
      details: expectedQuantity.greaterThan(observedQuantity)
        ? `Snapshot quantity ${expectedQuantity.toFixed()} ${expected?.unit ?? observed?.unit ?? "units"}; activity-derived quantity ${observedQuantity.toFixed()}. Add opening-lot evidence for ${expectedQuantity.minus(observedQuantity).toFixed()} to close the gap.`
        : `Snapshot quantity ${expectedQuantity.toFixed()} ${expected?.unit ?? observed?.unit ?? "units"}; activity-derived quantity ${observedQuantity.toFixed()}.`,
    });
    if (expectedQuantity.greaterThan(observedQuantity)) {
      gaps.push({
        dimension: "unexplained_opening_quantity",
        instrumentId,
        currency: null,
        expected: expectedQuantity.minus(observedQuantity).toFixed(),
        observed: "0",
        details: `Add opening-lot evidence for ${expectedQuantity.minus(observedQuantity).toFixed()} ${expected?.unit ?? observed?.unit ?? "units"} to close this history gap.`,
      });
    }
  }

  const expectedCash = new Map<string, Decimal>();
  for (const row of snapshotCash) {
    expectedCash.set(
      row.currency,
      new Decimal(decText(input.dataKey, row.amountCt, row.id, "amount_ct", row.version)!),
    );
  }
  const observedCash = new Map<string, Decimal>();
  // Cash held before the history began, as the owner recorded it.
  for (const row of openingCash) {
    observedCash.set(
      row.currency,
      new Decimal(decText(input.dataKey, row.amountCt, row.id, "amount_ct", row.version)!),
    );
  }
  for (const row of activities) {
    if (!row.currency || !row.netCashAmountCt) continue;
    const amount = decText(
      input.dataKey,
      row.netCashAmountCt,
      row.id,
      "net_cash_amount_ct",
      row.version,
    )!;
    observedCash.set(row.currency, (observedCash.get(row.currency) ?? new Decimal(0)).plus(amount));
  }
  for (const currency of new Set([...expectedCash.keys(), ...observedCash.keys()])) {
    const expected = expectedCash.get(currency) ?? new Decimal(0);
    const observed = observedCash.get(currency) ?? new Decimal(0);
    if (expected.equals(observed)) continue;
    gaps.push({
      dimension: "cash_balance",
      instrumentId: null,
      currency,
      expected: expected.toFixed(),
      observed: observed.toFixed(),
      details: `Snapshot cash ${expected.toFixed()} ${currency}; activity-derived cash ${observed.toFixed()} ${currency}.`,
    });
  }

  for (const row of coverage) {
    if (
      row.completeness === "complete" ||
      row.coverageBasis !== "earliest_observed" ||
      !row.coverageStart
    )
      continue;
    gaps.push({
      dimension: "coverage_start",
      instrumentId: row.instrumentId,
      currency: null,
      expected: null,
      observed: row.coverageStart,
      details: `Provider-declared account inception is unavailable; activity is observed from ${row.coverageStart}.`,
    });
  }
  for (const row of corporateActions) {
    gaps.push({
      dimension: "unsupported_corporate_action",
      instrumentId: row.instrumentId,
      currency: row.currency,
      expected: "0",
      observed: "1",
      details: `An unsupported corporate action dated ${row.actionDate} may affect derived lots.`,
    });
  }
  const pendingByInstrument = new Map<string | null, number>();
  const activityById = new Map(activities.map((row) => [row.id, row]));
  for (const row of pendingQueue) {
    if (row.kind === "reconciliation_gap") continue;
    const instrumentId = row.activityEvidenceId
      ? (activityById.get(row.activityEvidenceId)?.instrumentId ?? null)
      : null;
    pendingByInstrument.set(instrumentId, (pendingByInstrument.get(instrumentId) ?? 0) + 1);
  }
  for (const [instrumentId, count] of pendingByInstrument) {
    gaps.push({
      dimension: "pending_activity",
      instrumentId,
      currency: null,
      expected: "0",
      observed: String(count),
      details: `${count} activity item${count === 1 ? "" : "s"} require resolution before the projection is complete.`,
    });
  }

  const uniqueGaps = [...new Map(gaps.map((gap) => [reconciliationKey(gap), gap])).values()];
  const existing = await tx
    .select()
    .from(investmentReconciliationQuality)
    .where(
      and(
        eq(investmentReconciliationQuality.accountId, input.accountId),
        inArray(
          investmentReconciliationQuality.snapshotId,
          tx
            .select({ id: investmentSnapshotDetails.id })
            .from(investmentSnapshotDetails)
            .where(
              and(
                eq(investmentSnapshotDetails.accountId, input.accountId),
                lte(investmentSnapshotDetails.sourceAsOf, detail.sourceAsOf),
              ),
            ),
        ),
      ),
    );
  const desiredKeys = new Set(uniqueGaps.map(reconciliationKey));
  const existingByKey = new Map(
    existing
      .filter((row) => row.snapshotId === detail.id)
      .map((row) => [reconciliationKey(row), row]),
  );
  for (const row of existing) {
    if (
      (row.snapshotId === detail.id && desiredKeys.has(reconciliationKey(row))) ||
      row.status === "resolved"
    )
      continue;
    await tx
      .update(investmentReconciliationQuality)
      .set({ status: "resolved", resolvedAt: new Date() })
      .where(eq(investmentReconciliationQuality.id, row.id));
    await tx
      .update(investmentDisposalResolutionQueue)
      .set({ status: "resolved", resolvedAt: new Date() })
      .where(eq(investmentDisposalResolutionQueue.reconciliationQualityId, row.id));
  }

  const affectedInstrumentIds = new Set<string>();
  for (const gap of uniqueGaps) {
    if (gap.instrumentId) affectedInstrumentIds.add(gap.instrumentId);
    const current = existingByKey.get(reconciliationKey(gap));
    const same =
      current &&
      current.status === "pending" &&
      decText(
        input.dataKey,
        current.expectedValueCt,
        current.id,
        "expected_value_ct",
        current.version,
      ) === gap.expected &&
      decText(
        input.dataKey,
        current.observedValueCt,
        current.id,
        "observed_value_ct",
        current.version,
      ) === gap.observed;
    const id = current?.id ?? randomUUID();
    if (!same) {
      const version = current ? current.version + 1 : 1;
      const values = {
        ownerId: input.userId,
        accountId: input.accountId,
        instrumentId: gap.instrumentId,
        snapshotId: detail.id,
        dimension: gap.dimension,
        expectedValueCt:
          gap.expected === null
            ? null
            : encText(input.dataKey, gap.expected, id, "expected_value_ct", version),
        observedValueCt:
          gap.observed === null
            ? null
            : encText(input.dataKey, gap.observed, id, "observed_value_ct", version),
        currency: gap.currency,
        completeness: "partial" as const,
        status: "pending" as const,
        resolvedAt: null,
        version,
      };
      if (current)
        await tx
          .update(investmentReconciliationQuality)
          .set(values)
          .where(eq(investmentReconciliationQuality.id, id));
      else await tx.insert(investmentReconciliationQuality).values({ id, ...values });
    }
    if (gap.dimension === "unexplained_opening_quantity") continue;
    const [queued] = await tx
      .select()
      .from(investmentDisposalResolutionQueue)
      .where(
        and(
          eq(investmentDisposalResolutionQueue.reconciliationQualityId, id),
          eq(investmentDisposalResolutionQueue.kind, "reconciliation_gap"),
          eq(investmentDisposalResolutionQueue.policyVersion, input.policyVersion),
        ),
      )
      .limit(1);
    if (!queued) {
      const queueId = randomUUID();
      await tx.insert(investmentDisposalResolutionQueue).values({
        id: queueId,
        ownerId: input.userId,
        accountId: input.accountId,
        reconciliationQualityId: id,
        kind: "reconciliation_gap",
        detailsCt: encText(input.dataKey, gap.details, queueId, "details_ct", 1),
        policyVersion: input.policyVersion,
      });
    } else if (queued.status === "resolved") {
      await tx
        .update(investmentDisposalResolutionQueue)
        .set({ status: "pending", resolvedAt: null })
        .where(eq(investmentDisposalResolutionQueue.id, queued.id));
    }
  }

  for (const instrumentId of affectedInstrumentIds) {
    const current = coverage.find(
      (row) => row.instrumentId === instrumentId && row.metric === "cost_basis",
    );
    if (!current) {
      await tx.insert(investmentActivityCoverage).values({
        ownerId: input.userId,
        accountId: input.accountId,
        instrumentId,
        source: detail.source,
        metric: "cost_basis",
        completeness: "partial",
      });
    } else if (current.completeness !== "partial") {
      await tx
        .update(investmentActivityCoverage)
        .set({ completeness: "partial" })
        .where(eq(investmentActivityCoverage.id, current.id));
    }
  }

  return {
    snapshotId: detail.id,
    gaps: uniqueGaps.length,
    affectedInstrumentIds: [...affectedInstrumentIds].sort(),
  };
}

/** Reconciles one account's activity projection without changing snapshot or lot evidence. */
export function reconcileInvestmentActivity(
  input: InvestmentActivityReconciliationInput,
): Promise<InvestmentActivityReconciliationResult> {
  return withUser(input.userId, (tx) =>
    reconcileInvestmentActivityInTransaction(tx, {
      ...input,
      policyVersion: input.policyVersion ?? BROKER_ELSE_USER_POLICY_VERSION,
    }),
  );
}

export { emptyMetadata };
