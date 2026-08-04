// Demo/dev fixture data for Moni (T5). Wipes and reseeds a small family of
// users with accounts, categories, a few months of ledger entries, a
// recurring subscription, an internal transfer, and balance snapshots — just
// enough to build the overview dashboard against. See docs/design/data-model.md
// §5 for what each table means and docs/design/money-and-currency.md for the
// currency-triple / locked-FX-rate rules this data must stay consistent with.
//
// DEV ONLY, but real key custody: each user's data key is minted by
// src/domain/registration.ts's createUser() — the same function a real
// sign-up goes through — so it is genuinely random, never the dev key
// provider (src/lib/crypto/dev-key-provider.ts, which stays reserved for
// pure crypto unit tests). Requires MONI_SIGNUP_TOKEN to be set, matching
// the same gate a real sign-up faces (see .env.example).
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { and, eq, inArray } from "drizzle-orm";
import Decimal from "decimal.js";
import { withUser } from "@/db/client";
import * as schema from "@/db/schema";
import { encryptField, decryptField, wipe, type AadContext } from "@/lib/crypto";
import { normalizeDescription } from "@/lib/categorization/normalize";
import { multiply } from "@/lib/money";
import { createConnection } from "@/domain/connections";
import { promoteInvestmentSnapshot } from "@/domain/investment-promotion";
import { createUser } from "@/domain/registration";
import { startSyncRun } from "@/domain/sync-promotion";

// Demo login password shared by both seeded users (dev only). Printed in the
// seed summary. In production, users choose their own; here it just lets the
// login flow unwrap the seeded data key. See src/lib/auth/password.ts.
const DEMO_PASSWORD = "moni-demo";

// Written once and reused for both the entry description and the merchant's
// match text, so the two can never drift apart.
const SHUFERSAL_DESCRIPTION = "Shufersal grocery run";
const NETFLIX_DESCRIPTION = "Netflix subscription";
const NETFLIX_AMOUNT = "-49.90";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Encrypts a UTF-8 string under `dataKey`, bound to the row/column/version it's stored in. */
function enc(dataKey: Uint8Array, rowId: string, column: string, plaintext: string): Buffer {
  const aad: AadContext = { rowId, column, version: 1 };
  return encryptField(dataKey, Buffer.from(plaintext, "utf8"), aad);
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** decimal.js round-half-up to 2dp, as a canonical decimal string — for constructing
 * realistic fixture amounts (e.g. "what the bank statement would show"), never used
 * to round a stored value in real domain-layer code (money-and-currency.md §3). */
function round2(d: Decimal): string {
  return d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toString();
}

// ---------------------------------------------------------------------------
// 1. Wipe (elevated connection — TRUNCATE needs table-owner rights, and RLS
//    would block a cross-user DELETE under moni_app anyway). This and the
//    fx_rates writes below are the only two places this script uses the
//    elevated connection instead of withUser().
// ---------------------------------------------------------------------------
async function wipeAll(owner: Client): Promise<void> {
  await owner.query(`
    TRUNCATE TABLE
      entry_field_changelog, entry_transactions, entries, transfers,
      rule_actions, rule_conditions, rules, sync_staging, sync_runs, connections,
      account_balance_snapshots, credit_card_details, accounts, merchants, categories,
      fx_rates, users
    CASCADE
  `);
}

// ---------------------------------------------------------------------------
// 2. fx_rates (global reference data, no owner_id — moni_app is SELECT-only
//    per the T3 grants, so this also goes through the elevated connection).
//    A handful of deterministic ILS<->USD demo dates spanning the entries
//    below. They are explicitly not attributed to an external authority.
// ---------------------------------------------------------------------------
const DEMO_FX_SOURCE = "demo-fixed";
const FX_DATES_USD_ILS: Array<{ date: string; rate: string }> = [
  { date: "2026-05-01", rate: "3.70" },
  { date: "2026-05-15", rate: "3.72" },
  { date: "2026-06-01", rate: "3.68" },
  { date: "2026-06-15", rate: "3.71" },
  { date: "2026-07-01", rate: "3.73" },
  { date: "2026-07-15", rate: "3.75" },
  { date: "2026-07-24", rate: "3.74" },
];
// Captured from the official BOI USD representative-rate page. This is a real
// historical observation used to promote the deterministic investment demo.
const BOI_USD_ILS_FIXTURE = { date: "2026-07-28", rate: "3.058" } as const;
/** Rate lookup entries reuse so entries.fxRate is honestly "a real locked rate from
 * the seeded fx_rates table," not a coincidentally-matching separate number. */
const fxRateByDate = new Map(FX_DATES_USD_ILS.map((r) => [r.date, r.rate]));

async function seedFxRates(owner: Client): Promise<number> {
  let count = 0;
  for (const { date, rate } of FX_DATES_USD_ILS) {
    await owner.query(
      `INSERT INTO fx_rates (id, from_currency, to_currency, date, rate, source)
       VALUES ($1, 'USD', 'ILS', $2, $3, $4)`,
      [randomUUID(), date, rate, DEMO_FX_SOURCE],
    );
    count++;
    const inverse = new Decimal(1).dividedBy(new Decimal(rate)).toDecimalPlaces(6).toString();
    await owner.query(
      `INSERT INTO fx_rates (id, from_currency, to_currency, date, rate, source)
       VALUES ($1, 'ILS', 'USD', $2, $3, $4)`,
      [randomUUID(), date, inverse, DEMO_FX_SOURCE],
    );
    count++;
  }
  await owner.query(
    `INSERT INTO fx_rates (id, from_currency, to_currency, date, rate, source)
     VALUES ($1, 'USD', 'ILS', $2, $3, 'boi')`,
    [randomUUID(), BOI_USD_ILS_FIXTURE.date, BOI_USD_ILS_FIXTURE.rate],
  );
  count++;
  return count;
}

// ---------------------------------------------------------------------------
// 3. Per-user fixture definition. Everything below is written through
//    withUser(userId, ...) — a real exercise of the RLS-scoped write path,
//    not a bypass (security-design-principles.md §9-11).
// ---------------------------------------------------------------------------
interface UserPlan {
  email: string;
  displayName: string;
  checkingName: string;
  checkingInstitution: string;
  creditCardName: string;
  creditCardInstitution: string;
  thirdAccount: {
    type: "savings" | "investment";
    name: string;
    institution: string;
    currency: "ILS" | "USD";
    balance: string;
  };
  salaryAmount: string;
  rentAmount: string;
}

const USERS: UserPlan[] = [
  {
    email: "dana@moni.demo",
    displayName: "Dana",
    checkingName: "Bank Leumi Checking",
    checkingInstitution: "Bank Leumi",
    creditCardName: "Isracard Credit Card",
    creditCardInstitution: "Isracard",
    thirdAccount: {
      type: "savings",
      name: "Bank Leumi Savings",
      institution: "Bank Leumi",
      currency: "ILS",
      balance: "35000.00",
    },
    salaryAmount: "12500.00",
    rentAmount: "4500.00",
  },
  {
    email: "yossi@moni.demo",
    displayName: "Yossi",
    checkingName: "Bank Hapoalim Checking",
    checkingInstitution: "Bank Hapoalim",
    creditCardName: "Max Credit Card",
    creditCardInstitution: "Max",
    thirdAccount: {
      type: "investment",
      name: "Schwab Brokerage",
      institution: "Charles Schwab",
      currency: "USD",
      balance: "18250.00",
    },
    salaryAmount: "15800.00",
    rentAmount: "5200.00",
  },
];

const ENTRY_DATES_MONTHS = ["2026-05", "2026-06", "2026-07"];
const TODAY = "2026-07-24";

interface SeedCounts {
  users: number;
  categories: number;
  merchants: number;
  accounts: number;
  creditCardDetails: number;
  entries: number;
  entryTransactions: number;
  transfers: number;
  accountBalanceSnapshots: number;
  connections: number;
  syncRuns: number;
  investmentPositions: number;
  investmentCashBalances: number;
}

/** A seeded user's identity + the real data key createUser() minted for it —
 * needed after seedUser() returns, both to keep encrypting fixture rows for
 * this user and for the decrypt round-trip proof at the end. */
interface SeededUser {
  plan: UserPlan;
  userId: string;
  dataKey: Buffer;
}

function requireSignupToken(): string {
  const token = process.env.MONI_SIGNUP_TOKEN;
  if (!token) {
    throw new Error(
      "MONI_SIGNUP_TOKEN is not set (see .env.example) — required to seed demo users " +
        "through the real registration path (src/domain/registration.ts createUser()).",
    );
  }
  return token;
}

async function seedUser(plan: UserPlan, counts: SeedCounts): Promise<SeededUser> {
  // Mints real, random key custody through the same function a real sign-up
  // uses (src/domain/registration.ts) — never the dev key provider.
  const password = Buffer.from(DEMO_PASSWORD, "utf8");
  const { userId, dataKey } = await createUser(plan.email, password, requireSignupToken());
  wipe(password);
  counts.users++;

  await withUser(userId, async (tx) => {
    // --- categories ----------------------------------------------------
    // createUser() already seeded the shipped default tree
    // (src/lib/categorization/default-categories.ts), so this looks up the
    // handful the demo ledger needs by their stable `builtin_key` rather
    // than inventing a second, divergent set.
    const seededCategories = await tx
      .select({ id: schema.categories.id, builtinKey: schema.categories.builtinKey })
      .from(schema.categories);
    counts.categories += seededCategories.length;

    const idByBuiltinKey = new Map(
      seededCategories.filter((c) => c.builtinKey).map((c) => [c.builtinKey as string, c.id]),
    );
    const requireCategory = (builtinKey: string): string => {
      const id = idByBuiltinKey.get(builtinKey);
      if (!id) throw new Error(`Default category "${builtinKey}" was not seeded`);
      return id;
    };
    const categoryIds: Record<string, string> = {
      salary: requireCategory("income-salary"),
      groceries: requireCategory("food-groceries"),
      transport: requireCategory("transport-public"),
      rent: requireCategory("housing-rent"),
      entertainment: requireCategory("entertainment-subscriptions"),
    };

    // --- merchants -------------------------------------------------------
    // `match_text_ct` is the merchant's identity (docs/adr/0005-*), so it is
    // derived from the same description these merchants' entries carry
    // below — seed a different string and the resolver would create a second
    // merchant for the same payee on the next sync.
    const shufersalId = randomUUID();
    const netflixId = randomUUID();
    await tx.insert(schema.merchants).values([
      {
        id: shufersalId,
        ownerId: userId,
        nameCt: enc(dataKey, shufersalId, "name_ct", "Shufersal"),
        matchTextCt: enc(
          dataKey,
          shufersalId,
          "match_text_ct",
          normalizeDescription(SHUFERSAL_DESCRIPTION),
        ),
        source: "manual",
      },
      {
        id: netflixId,
        ownerId: userId,
        nameCt: enc(dataKey, netflixId, "name_ct", "Netflix"),
        matchTextCt: enc(
          dataKey,
          netflixId,
          "match_text_ct",
          normalizeDescription(NETFLIX_DESCRIPTION),
        ),
        source: "manual",
      },
    ]);
    counts.merchants += 2;

    // The recurring view's only gate: without a flagged category it shows
    // nothing at all, so the demo flags the two that make it worth looking at
    // — one expense section and one income section (docs/adr/0006-*).
    await tx
      .update(schema.categories)
      .set({ isRecurring: true })
      .where(
        and(
          eq(schema.categories.ownerId, userId),
          inArray(schema.categories.id, [categoryIds.entertainment, categoryIds.salary]),
        ),
      );

    // --- accounts -------------------------------------------------------
    const checkingId = randomUUID();
    const creditCardId = randomUUID();
    const thirdAccountId = randomUUID();

    const checkingBalance = "22000.00";
    const creditCardBalance = "-2350.40";

    await tx.insert(schema.accounts).values([
      {
        id: checkingId,
        ownerId: userId,
        accountType: "checking",
        classification: "asset",
        nameCt: enc(dataKey, checkingId, "name_ct", plan.checkingName),
        institution: plan.checkingInstitution,
        accountNumberLast4Ct: enc(dataKey, checkingId, "account_number_last4_ct", "4821"),
        currency: "ILS",
        currentBalanceCt: enc(dataKey, checkingId, "current_balance_ct", checkingBalance),
      },
      {
        id: creditCardId,
        ownerId: userId,
        accountType: "credit_card",
        classification: "liability",
        nameCt: enc(dataKey, creditCardId, "name_ct", plan.creditCardName),
        institution: plan.creditCardInstitution,
        accountNumberLast4Ct: enc(dataKey, creditCardId, "account_number_last4_ct", "7734"),
        currency: "ILS",
        currentBalanceCt: enc(dataKey, creditCardId, "current_balance_ct", creditCardBalance),
      },
      ...(plan.thirdAccount.type === "savings"
        ? [
            {
              id: thirdAccountId,
              ownerId: userId,
              accountType: plan.thirdAccount.type,
              classification: "asset" as const,
              nameCt: enc(dataKey, thirdAccountId, "name_ct", plan.thirdAccount.name),
              institution: plan.thirdAccount.institution,
              accountNumberLast4Ct: enc(dataKey, thirdAccountId, "account_number_last4_ct", "9012"),
              currency: plan.thirdAccount.currency,
              currentBalanceCt: enc(
                dataKey,
                thirdAccountId,
                "current_balance_ct",
                plan.thirdAccount.balance,
              ),
            },
          ]
        : []),
    ]);
    counts.accounts += plan.thirdAccount.type === "savings" ? 3 : 2;

    // --- credit_card_details ---------------------------------------------
    await tx.insert(schema.creditCardDetails).values({
      accountId: creditCardId,
      ownerId: userId,
      statementCloseDay: 10,
      paymentDueDay: 25,
      creditLimitCt: enc(dataKey, creditCardId, "credit_limit_ct", "20000.00"),
    });
    counts.creditCardDetails++;

    // --- account_balance_snapshots (one per account, "as of today") ------
    const snapshotDefs = [
      { accountId: checkingId, amount: checkingBalance, currency: "ILS" },
      { accountId: creditCardId, amount: creditCardBalance, currency: "ILS" },
      ...(plan.thirdAccount.type === "savings"
        ? [
            {
              accountId: thirdAccountId,
              amount: plan.thirdAccount.balance,
              currency: plan.thirdAccount.currency,
            },
          ]
        : []),
    ];
    for (const s of snapshotDefs) {
      const id = randomUUID();
      await tx.insert(schema.accountBalanceSnapshots).values({
        id,
        ownerId: userId,
        accountId: s.accountId,
        date: TODAY,
        nativeBalanceCt: enc(dataKey, id, "native_balance_ct", s.amount),
        currency: s.currency,
        source: "manual",
      });
      counts.accountBalanceSnapshots++;
    }

    // --- entries + entry_transactions ------------------------------------
    interface EntryDef {
      date: string;
      description: string;
      accountId: string;
      categoryId?: string;
      merchantId?: string;
      enteredAmount: string;
      enteredCurrency: "ILS" | "USD";
      accountAmount: string;
      accountCurrency: "ILS" | "USD";
      fxRate: string | null;
      fxStatus: "locked" | "pending";
      fxSource: string | null;
      source: "scrape" | "manual";
      excluded?: boolean;
      kind: "standard" | "transfer";
      notes?: string;
    }

    const entryDefs: EntryDef[] = [];

    for (const month of ENTRY_DATES_MONTHS) {
      // Salary — income, into checking, on the 25th (or the 24th for the
      // partial final month so it stays within TODAY).
      const salaryDate = month === "2026-07" ? "2026-07-24" : `${month}-25`;
      entryDefs.push({
        date: salaryDate,
        description: "Monthly salary",
        accountId: checkingId,
        categoryId: categoryIds.salary,
        enteredAmount: plan.salaryAmount,
        enteredCurrency: "ILS",
        accountAmount: plan.salaryAmount,
        accountCurrency: "ILS",
        fxRate: "1",
        fxStatus: "locked",
        fxSource: "identity",
        source: "manual",
        kind: "standard",
      });

      // Rent — expense, from checking, on the 1st.
      entryDefs.push({
        date: `${month}-01`,
        description: "Rent payment",
        accountId: checkingId,
        categoryId: categoryIds.rent,
        enteredAmount: `-${plan.rentAmount}`,
        enteredCurrency: "ILS",
        accountAmount: `-${plan.rentAmount}`,
        accountCurrency: "ILS",
        fxRate: "1",
        fxStatus: "locked",
        fxSource: "identity",
        source: "manual",
        kind: "standard",
      });

      // Groceries — two per month, on the credit card.
      for (const [offset, amount] of [
        [4, "-312.50"],
        [18, "-268.90"],
      ] as const) {
        entryDefs.push({
          date: addDays(`${month}-01`, offset),
          description: SHUFERSAL_DESCRIPTION,
          accountId: creditCardId,
          categoryId: categoryIds.groceries,
          merchantId: shufersalId,
          enteredAmount: amount,
          enteredCurrency: "ILS",
          accountAmount: amount,
          accountCurrency: "ILS",
          fxRate: "1",
          fxStatus: "locked",
          fxSource: "identity",
          source: "scrape",
          kind: "standard",
        });
      }

      // Transport — one or two per month.
      entryDefs.push({
        date: addDays(`${month}-01`, 9),
        description: "Rav-Kav top-up",
        accountId: creditCardId,
        categoryId: categoryIds.transport,
        enteredAmount: "-120.00",
        enteredCurrency: "ILS",
        accountAmount: "-120.00",
        accountCurrency: "ILS",
        fxRate: "1",
        fxStatus: "locked",
        fxSource: "identity",
        source: "scrape",
        kind: "standard",
      });

      // Entertainment (non-subscription) — one per month.
      entryDefs.push({
        date: addDays(`${month}-01`, 14),
        description: "Cinema City",
        accountId: creditCardId,
        categoryId: categoryIds.entertainment,
        enteredAmount: "-96.00",
        enteredCurrency: "ILS",
        accountAmount: "-96.00",
        accountCurrency: "ILS",
        fxRate: "1",
        fxStatus: "locked",
        fxSource: "identity",
        source: "scrape",
        kind: "standard",
      });

      // Netflix — the recurring subscription entry for this month.
      entryDefs.push({
        date: `${month}-05`,
        description: NETFLIX_DESCRIPTION,
        accountId: creditCardId,
        categoryId: categoryIds.entertainment,
        merchantId: netflixId,
        enteredAmount: NETFLIX_AMOUNT,
        enteredCurrency: "ILS",
        accountAmount: NETFLIX_AMOUNT,
        accountCurrency: "ILS",
        fxRate: "1",
        fxStatus: "locked",
        fxSource: "identity",
        source: "scrape",
        kind: "standard",
      });
    }

    // USD purchases on the ILS credit card — exercises the currency triple
    // with a real locked rate from the seeded fx_rates table.
    for (const date of ["2026-05-15", "2026-06-15"]) {
      const rate = fxRateByDate.get(date);
      if (!rate) throw new Error(`No seeded fx_rate for ${date}`);
      const usdAmount = "-45.00";
      const converted = multiply({ amount: usdAmount, currency: "USD" }, rate);
      const ilsAmount = round2(new Decimal(converted.amount));
      entryDefs.push({
        date,
        description: "Amazon.com purchase",
        accountId: creditCardId,
        categoryId: categoryIds.entertainment,
        enteredAmount: usdAmount,
        enteredCurrency: "USD",
        accountAmount: ilsAmount,
        accountCurrency: "ILS",
        fxRate: rate,
        fxStatus: "locked",
        fxSource: DEMO_FX_SOURCE,
        source: "scrape",
        kind: "standard",
      });
    }

    // Pending FX entry — a foreign-currency charge dated today, for which no
    // rate has been backfilled yet (data-model.md §4.2: never fake a missing
    // rate). fxRate stays null; fxRateDate still records the date a rate is
    // needed for.
    entryDefs.push({
      date: TODAY,
      description: "eBay purchase (rate pending)",
      accountId: creditCardId,
      categoryId: categoryIds.entertainment,
      enteredAmount: "-32.00",
      enteredCurrency: "USD",
      accountAmount: "-119.50",
      accountCurrency: "ILS",
      fxRate: null,
      fxStatus: "pending",
      fxSource: null,
      source: "scrape",
      kind: "standard",
      notes: "Awaiting FX backfill job",
    });

    // Internal transfer pair. Dana: checking -> savings. Yossi: checking ->
    // credit-card payment. Both legs excluded from income/expense totals.
    const transferAmount = plan.thirdAccount.type === "savings" ? "1000.00" : "800.00";
    const outflowId = randomUUID();
    const inflowId = randomUUID();
    entryDefs.push({
      date: addDays(TODAY, -3),
      description:
        plan.thirdAccount.type === "savings" ? "Transfer to savings" : "Credit card payment",
      accountId: checkingId,
      enteredAmount: `-${transferAmount}`,
      enteredCurrency: "ILS",
      accountAmount: `-${transferAmount}`,
      accountCurrency: "ILS",
      fxRate: "1",
      fxStatus: "locked",
      fxSource: "identity",
      source: "manual",
      excluded: true,
      kind: "transfer",
    });
    const outflowDefIndex = entryDefs.length - 1;
    entryDefs.push({
      date: addDays(TODAY, -3),
      description:
        plan.thirdAccount.type === "savings" ? "Transfer from checking" : "Payment received",
      accountId: plan.thirdAccount.type === "savings" ? thirdAccountId : creditCardId,
      enteredAmount: transferAmount,
      enteredCurrency: "ILS",
      accountAmount: transferAmount,
      accountCurrency: "ILS",
      fxRate: "1",
      fxStatus: "locked",
      fxSource: "identity",
      source: "manual",
      excluded: true,
      kind: "transfer",
    });
    const inflowDefIndex = entryDefs.length - 1;

    // Assign fixed ids up front (needed for AAD before insert) and insert.
    const entryIds = entryDefs.map(() => randomUUID());
    // Force the transfer pair to use the ids we already generated for the
    // `transfers` row below.
    entryIds[outflowDefIndex] = outflowId;
    entryIds[inflowDefIndex] = inflowId;

    for (let i = 0; i < entryDefs.length; i++) {
      const def = entryDefs[i];
      const id = entryIds[i];
      await tx.insert(schema.entries).values({
        id,
        ownerId: userId,
        accountId: def.accountId,
        entryType: "transaction",
        date: def.date,
        descriptionCt: enc(dataKey, id, "description_ct", def.description),
        notesCt: def.notes ? enc(dataKey, id, "notes_ct", def.notes) : null,
        categoryId: def.categoryId ?? null,
        merchantId: def.merchantId ?? null,
        status: "posted",
        excluded: def.excluded ?? false,
        enteredAmountCt: enc(dataKey, id, "entered_amount_ct", def.enteredAmount),
        enteredCurrency: def.enteredCurrency,
        accountAmountCt: enc(dataKey, id, "account_amount_ct", def.accountAmount),
        accountCurrency: def.accountCurrency,
        reportingCurrency: "ILS",
        fxRate: def.fxRate,
        fxRateDate: def.date,
        fxSource: def.fxSource,
        fxStatus: def.fxStatus,
        source: def.source,
      });
      counts.entries++;

      await tx.insert(schema.entryTransactions).values({
        entryId: id,
        ownerId: userId,
        kind: def.kind,
      });
      counts.entryTransactions++;
    }

    // --- transfers ---------------------------------------------------------
    await tx.insert(schema.transfers).values({
      id: randomUUID(),
      ownerId: userId,
      inflowEntryId: inflowId,
      outflowEntryId: outflowId,
      status: "completed",
    });
    counts.transfers++;
  });

  // Keep both demo users past onboarding. Dana exercises the empty import
  // state; Yossi has a complete normalized investment snapshot for the
  // production portfolio screen.
  const { id: investmentConnectionId } = await createConnection(
    userId,
    "schwab_positions_csv",
    null,
    null,
    plan.thirdAccount.type === "investment" ? "Schwab Brokerage" : "Schwab CSV",
  );
  counts.connections++;

  if (plan.thirdAccount.type === "investment") {
    const syncRunId = await startSyncRun(userId, investmentConnectionId);
    counts.syncRuns++;
    const asOf = `${BOI_USD_ILS_FIXTURE.date}T12:00:00Z`;
    const promoted = await promoteInvestmentSnapshot({
      userId,
      connectionId: investmentConnectionId,
      syncRunId,
      dataKey,
      envelope: {
        source: "schwab_positions_csv",
        coverage: { kind: "bound_single_account", accountRefs: ["****9012"] },
        sourceAsOf: { value: asOf, precision: "timestamp" },
        accounts: [
          {
            sourceAccountRef: "****9012",
            baseCurrency: "USD",
            positions: [
              {
                sourceSecurityId: "SPY",
                sourceSecurityIdKind: "schwab_symbol",
                symbol: "SPY",
                name: "SPDR S&P 500 ETF Trust",
                exchange: "NYSE",
                assetKind: "etf",
                quantity: "100",
                quantityUnit: "shares",
                currency: "USD",
                sourcePrice: "150",
                sourcePriceCurrency: "USD",
                sourceValue: "15000",
                sourceValueCurrency: "USD",
                sourceAsOf: asOf,
              },
              {
                sourceSecurityId: "IXUS",
                sourceSecurityIdKind: "schwab_symbol",
                symbol: "IXUS",
                name: "iShares Core MSCI Total International Stock ETF",
                exchange: "NASDAQ",
                assetKind: "etf",
                quantity: "50",
                quantityUnit: "shares",
                currency: "USD",
                sourcePrice: "60",
                sourcePriceCurrency: "USD",
                sourceValue: "3000",
                sourceValueCurrency: "USD",
                sourceAsOf: asOf,
              },
            ],
            cash: [{ currency: "USD", amount: "250" }],
            brokerTotal: { amount: "18250", currency: "USD", asOf },
          },
        ],
      },
    });
    counts.accounts += promoted.accounts;
    counts.accountBalanceSnapshots += promoted.accounts;
    counts.investmentPositions += promoted.positions;
    counts.investmentCashBalances += promoted.cashBalances;
  }

  return { plan, userId, dataKey };
}

// ---------------------------------------------------------------------------
// 4. Decrypt round-trip proof — reads one seeded field back through the
//    normal RLS-scoped path and decrypts it with the same AAD used to
//    encrypt, proving the ciphertext is honest, not opaque filler.
// ---------------------------------------------------------------------------
async function proveRoundTrip(seeded: SeededUser): Promise<{ field: string; value: string }> {
  return withUser(seeded.userId, async (tx) => {
    const [account] = await tx
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.ownerId, seeded.userId))
      .limit(1);
    if (!account) throw new Error("Round-trip check: no account found");
    const plaintext = decryptField(seeded.dataKey, account.nameCt, {
      rowId: account.id,
      column: "name_ct",
      version: account.version,
    });
    return {
      field: `accounts.name_ct (${seeded.plan.email})`,
      value: plaintext.toString("utf8"),
    };
  });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const migrateUrl = process.env.DATABASE_URL_MIGRATE;
  if (!migrateUrl) {
    throw new Error("DATABASE_URL_MIGRATE is not set (see .env.example)");
  }
  const owner = new Client({ connectionString: migrateUrl });
  await owner.connect();

  const counts: SeedCounts = {
    users: 0,
    categories: 0,
    merchants: 0,
    accounts: 0,
    creditCardDetails: 0,
    entries: 0,
    entryTransactions: 0,
    transfers: 0,
    accountBalanceSnapshots: 0,
    connections: 0,
    syncRuns: 0,
    investmentPositions: 0,
    investmentCashBalances: 0,
  };

  try {
    console.log("Wiping existing data...");
    await wipeAll(owner);

    console.log("Seeding fx_rates...");
    const fxRateCount = await seedFxRates(owner);

    const seededUsers: SeededUser[] = [];
    for (const plan of USERS) {
      console.log(`Seeding user ${plan.displayName} (${plan.email})...`);
      seededUsers.push(await seedUser(plan, counts));
    }

    console.log("\nVerifying encryption round-trip...");
    const roundTrips = await Promise.all(seededUsers.map(proveRoundTrip));

    console.log("\n=== Seed summary ===");
    for (const s of seededUsers) {
      console.log(`- ${s.plan.displayName}: ${s.plan.email} (id ${s.userId})`);
    }
    console.log(`demo login password (both users): ${DEMO_PASSWORD}`);
    console.log(`fx_rates: ${fxRateCount}`);
    console.log(`users: ${counts.users}`);
    console.log(`categories: ${counts.categories}`);
    console.log(`merchants: ${counts.merchants}`);
    console.log(`accounts: ${counts.accounts}`);
    console.log(`credit_card_details: ${counts.creditCardDetails}`);
    console.log(`entries: ${counts.entries}`);
    console.log(`entry_transactions: ${counts.entryTransactions}`);
    console.log(`transfers: ${counts.transfers}`);
    console.log(`account_balance_snapshots: ${counts.accountBalanceSnapshots}`);
    console.log(`connections: ${counts.connections}`);
    console.log(`sync_runs: ${counts.syncRuns}`);
    console.log(`investment_snapshot_positions: ${counts.investmentPositions}`);
    console.log(`investment_snapshot_cash_balances: ${counts.investmentCashBalances}`);
    console.log("\nDecrypt round-trip proof:");
    for (const rt of roundTrips) {
      console.log(`- ${rt.field} -> "${rt.value}"`);
    }

    // Seeding + verification are done — wipe the data keys createUser()
    // returned (Tier-0 hygiene; the script is about to exit anyway, but
    // never rely on process exit to clear a secret it's still holding).
    for (const s of seededUsers) wipe(s.dataKey);
  } finally {
    await owner.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
