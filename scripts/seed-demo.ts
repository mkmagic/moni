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
import { encText } from "@/domain/fields";
import { normalizeDescription } from "@/lib/categorization/normalize";
import { multiply } from "@/lib/money";
import { createConnection } from "@/domain/connections";
import { ingestInvestmentActivityEvidence } from "@/domain/investment-activity";
import { promoteInvestmentSnapshot } from "@/domain/investment-promotion";
import { deriveInvestmentTaxLots, BROKER_ELSE_USER_POLICY_VERSION } from "@/domain/investment-lots";
import { readPortfolioInvestmentReturns } from "@/domain/investment-returns";
import { reconcileInvestmentActivity } from "@/domain/investment-valuation";
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
/** "2026-07" + 1 → "2026-08". Month arithmetic on the string, so it never
 * meets a Date's month-length rounding. */
function shiftMonthString(month: string, by: number): string {
  const [year, m] = month.split("-").map(Number);
  const zero = year * 12 + (m - 1) + by;
  return `${Math.floor(zero / 12)}-${String((zero % 12) + 1).padStart(2, "0")}`;
}

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

/**
 * Every month the ledger covers: the three pinned complete months above, plus
 * each month since, up to and including the one we are in.
 *
 * The tail is derived rather than pinned so the demo always has a **current**
 * month in progress. Without it the budget page — whose whole subject is the
 * month you are living in — opens on an empty one, and the budget wizard has
 * nothing to show a result against. Entries past today are dropped when the
 * defs are built, so the current month is genuinely partial.
 */
const SEED_MONTHS = ((): string[] => {
  const months = [...ENTRY_DATES_MONTHS];
  const current = new Date().toISOString().slice(0, 7);
  let next = shiftMonthString(months[months.length - 1], 1);
  while (next <= current) {
    months.push(next);
    next = shiftMonthString(next, 1);
  }
  return months;
})();

/** Last date any entry may carry — nothing is seeded into the future. */
const LAST_ENTRY_DATE = new Date().toISOString().slice(0, 10);

/**
 * Per-month spending, so the months differ from each other. Identical months
 * would make every "typical spend" suggestion look perfect and tell the owner
 * nothing about whether a suggestion is any good. Indexed modulo its length,
 * so it keeps working however many months `SEED_MONTHS` ends up covering.
 */
const MONTHLY_SPEND: Array<{ groceries: string[]; transport: string[]; cinema: string[] }> = [
  { groceries: ["-312.50", "-268.90"], transport: ["-120.00"], cinema: ["-96.00"] },
  { groceries: ["-402.10", "-288.40", "-151.75"], transport: ["-120.00"], cinema: [] },
  { groceries: ["-356.75", "-211.20"], transport: ["-120.00", "-64.00"], cinema: ["-148.00"] },
];

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
          // Rent is here for the budget planner rather than the recurring
          // view: `is_recurring` is also what sorts a category into the
          // budget's Fixed section, and a demo whose only fixed cost is
          // subscriptions has nothing to show on that step.
          inArray(schema.categories.id, [
            categoryIds.entertainment,
            categoryIds.salary,
            categoryIds.rent,
          ]),
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
      /** One payment of an installment deal. `enteredAmount` above is that
       * payment alone and `date` is when it is charged; the deal's own sum
       * and purchase date live here (issue #69 part A). */
      installment?: {
        number: number;
        total: number;
        dealAmount: string;
        dealCurrency: string;
        purchaseDate: string;
      };
    }

    const entryDefs: EntryDef[] = [];

    // A ₪12,000 appliance bought on the card in 12 payments. Only the first
    // three have been charged inside the seeded window — the rest arrive in
    // months the demo doesn't cover yet, which is exactly how a real card
    // reports one: twelve independent charges, ₪1,000 each, one per month.
    for (const [index, month] of SEED_MONTHS.entries()) {
      entryDefs.push({
        date: `${month}-10`,
        description: "Electric appliances",
        accountId: creditCardId,
        categoryId: categoryIds.entertainment,
        enteredAmount: "-1000",
        enteredCurrency: "ILS",
        accountAmount: "-1000",
        accountCurrency: "ILS",
        fxRate: "1",
        fxStatus: "locked",
        fxSource: "identity",
        source: "scrape",
        kind: "standard",
        installment: {
          number: index + 1,
          total: 12,
          dealAmount: "-12000",
          dealCurrency: "ILS",
          purchaseDate: `${ENTRY_DATES_MONTHS[0]}-08`,
        },
      });
    }

    for (const [monthIndex, month] of SEED_MONTHS.entries()) {
      const spend = MONTHLY_SPEND[monthIndex % MONTHLY_SPEND.length];

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

      // Groceries — a few a month, on the credit card. Spread across the
      // month so a partial current month holds only the runs that have
      // already happened.
      for (const [index, amount] of spend.groceries.entries()) {
        entryDefs.push({
          date: addDays(`${month}-01`, 4 + index * 9),
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
      for (const [index, amount] of spend.transport.entries()) {
        entryDefs.push({
          date: addDays(`${month}-01`, 9 + index * 11),
          description: "Rav-Kav top-up",
          accountId: creditCardId,
          categoryId: categoryIds.transport,
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

      // Entertainment (non-subscription) — not every month.
      for (const amount of spend.cinema) {
        entryDefs.push({
          date: addDays(`${month}-01`, 14),
          description: "Cinema City",
          accountId: creditCardId,
          categoryId: categoryIds.entertainment,
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

    // The month we are in is only partly over, so drop the entries whose day
    // has not arrived. Everything pushed from here on is pinned to a past
    // date, and two of those pushes are index-captured for the transfer pair
    // below — which is why this prunes here rather than at the end.
    entryDefs.splice(
      0,
      entryDefs.length,
      ...entryDefs.filter((def) => def.date <= LAST_ENTRY_DATE),
    );

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
        installmentNumber: def.installment?.number ?? null,
        totalInstallments: def.installment?.total ?? null,
        installmentTotalAmountCt: def.installment
          ? enc(dataKey, id, "installment_total_amount_ct", def.installment.dealAmount)
          : null,
        installmentTotalCurrency: def.installment?.dealCurrency ?? null,
        installmentPurchaseDate: def.installment?.purchaseDate ?? null,
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

    // Give the investment demo user the "tricky states" the #135 activity/lots
    // work needs to show: realized closures, booked dividends, and one genuine
    // row of each resolution-queue kind — all produced by the REAL pipeline
    // (ingest / derive / reconcile) over crafted fixtures, plus a partial and
    // an unknown completeness metric. See seedInvestmentActivityStates.
    await seedInvestmentActivityStates(userId, dataKey);
  }

  return { plan, userId, dataKey };
}

// ---------------------------------------------------------------------------
// 3b. Investment "tricky states" for the demo (#135). Everything a genuine
//     activity/lot history exercises: a realized closure, a booked dividend,
//     and one real row of each resolution-queue kind. The three queue rows are
//     produced by the actual domain pipeline (deriveInvestmentTaxLots →
//     unresolved_disposal, reconcileInvestmentActivity → reconciliation_gap,
//     ingestInvestmentActivityEvidence fingerprint collision →
//     identity_ambiguity), never inserted directly. Idempotent with the seed's
//     wipe (users TRUNCATE ... CASCADE drops all of it).
// ---------------------------------------------------------------------------

/** The Sunday on or before `date`, the week_start snapshots are constrained to. */
function weekStartSunday(date: string): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() - at.getUTCDay());
  return at.toISOString().slice(0, 10);
}

async function seedInvestmentActivityStates(userId: string, dataKey: Uint8Array): Promise<void> {
  const accountId = randomUUID();
  const aapl = randomUUID();
  const vti = randomUUID();
  const zgap = randomUUID();

  const { connectionId, syncRunId } = await withUser(userId, async (tx) => {
    const [connection] = await tx
      .insert(schema.connections)
      .values({
        ownerId: userId,
        connectorId: "ibkr_flex",
        credentialsCt: Buffer.from("seed-only"),
        status: "active",
        displayName: "Interactive Brokers",
      })
      .returning({ id: schema.connections.id });
    const [run] = await tx
      .insert(schema.syncRuns)
      .values({ ownerId: userId, connectionId: connection.id, status: "running" })
      .returning({ id: schema.syncRuns.id });
    await tx.insert(schema.accounts).values({
      id: accountId,
      ownerId: userId,
      connectionId: connection.id,
      accountType: "investment",
      classification: "asset",
      nameCt: encText(dataKey, "Interactive Brokers", accountId, "name_ct", 1),
      externalAccountRefCt: encText(dataKey, "DEMO-IBKR", accountId, "external_account_ref_ct", 1),
      currency: "USD",
      status: "active",
    });
    for (const [id, kind, symbol, name] of [
      [aapl, "stock", "AAPL", "Apple Inc."],
      [vti, "etf", "VTI", "Vanguard Total Stock Market ETF"],
      [zgap, "etf", "ZGAP", "Zenith Gap Fund ETF"],
    ] as const) {
      await tx.insert(schema.instruments).values({
        id,
        ownerId: userId,
        kind,
        canonicalSymbolCt: encText(dataKey, symbol, id, "canonical_symbol_ct", 1),
        canonicalNameCt: encText(dataKey, name, id, "canonical_name_ct", 1),
      });
    }
    return { connectionId: connection.id, syncRunId: run.id };
  });

  // --- Realized closure + booked dividend on AAPL (feeds the real gain and
  //     dividend READ paths; the closure carries its own locked FX). ---
  await withUser(userId, async (tx) => {
    const openingId = randomUUID();
    await tx.insert(schema.investmentOpeningLotEvidence).values({
      id: openingId,
      ownerId: userId,
      accountId,
      instrumentId: aapl,
      idempotencyKey: Buffer.from("demo-aapl-opening"),
      tradeDate: "2026-05-01",
      originalQuantityCt: encText(dataKey, "10", openingId, "original_quantity_ct", 1),
      remainingQuantityCt: encText(dataKey, "6", openingId, "remaining_quantity_ct", 1),
      quantityUnit: "shares",
      totalCostCt: encText(dataKey, "1500", openingId, "total_cost_ct", 1),
      currency: "USD",
      lockedFxRateCt: encText(dataKey, "3.70", openingId, "locked_fx_rate_ct", 1),
      lockedFxConvention: "ILS_PER_USD",
      lockedFxObservationDate: "2026-05-01",
      lockedFxProvenance: "boi_derived",
      provenance: "user_entered",
    });
    const lotId = randomUUID();
    await tx.insert(schema.investmentTaxLots).values({
      id: lotId,
      ownerId: userId,
      accountId,
      instrumentId: aapl,
      openingLotEvidenceId: openingId,
      derivationKey: Buffer.from("demo-aapl-lot"),
      policyVersion: BROKER_ELSE_USER_POLICY_VERSION,
      tradeDate: "2026-05-01",
      originalQuantityCt: encText(dataKey, "10", lotId, "original_quantity_ct", 1),
      remainingQuantityCt: encText(dataKey, "6", lotId, "remaining_quantity_ct", 1),
      quantityUnit: "shares",
      costBasisCt: encText(dataKey, "1500", lotId, "cost_basis_ct", 1),
      costBasisCurrency: "USD",
      lockedFxRateCt: encText(dataKey, "3.70", lotId, "locked_fx_rate_ct", 1),
      lockedFxConvention: "ILS_PER_USD",
      lockedFxObservationDate: "2026-05-01",
      lockedFxProvenance: "boi_derived",
      completeness: "complete",
    });
    const saleId = randomUUID();
    await tx.insert(schema.investmentActivityEvidence).values({
      id: saleId,
      ownerId: userId,
      connectionId,
      syncRunId,
      accountId,
      instrumentId: aapl,
      source: "ibkr_flex",
      activityType: "sell",
      idempotencyKey: Buffer.from("demo-aapl-sell"),
      tradeDate: "2026-06-15",
      quantityCt: encText(dataKey, "-4", saleId, "quantity_ct", 1),
      quantityUnit: "shares",
      grossAmountCt: encText(dataKey, "760", saleId, "gross_amount_ct", 1),
      netCashAmountCt: encText(dataKey, "760", saleId, "net_cash_amount_ct", 1),
      currency: "USD",
      rawTypeCt: encText(dataKey, "Trade", saleId, "raw_type_ct", 1),
      provenance: "broker_reported",
    });
    const closureId = randomUUID();
    await tx.insert(schema.investmentLotClosures).values({
      id: closureId,
      ownerId: userId,
      sellActivityEvidenceId: saleId,
      closedTaxLotId: lotId,
      closedQuantityCt: encText(dataKey, "4", closureId, "closed_quantity_ct", 1),
      proceedsCt: encText(dataKey, "760", closureId, "proceeds_ct", 1),
      realizedCostBasisCt: encText(dataKey, "600", closureId, "realized_cost_basis_ct", 1),
      lockedFxRateCt: encText(dataKey, "3.71", closureId, "locked_fx_rate_ct", 1),
      lockedFxConvention: "ILS_PER_USD",
      lockedFxObservationDate: "2026-06-15",
      lockedFxProvenance: "boi_derived",
      allocationProvenance: "broker_reported",
    });
    // AAPL cost basis is known (partial — the account still has an unresolved
    // disposal), so realized reads Partial rather than unknown.
    await tx.insert(schema.investmentActivityCoverage).values({
      ownerId: userId,
      accountId,
      instrumentId: aapl,
      source: "ibkr_flex",
      metric: "cost_basis",
      completeness: "partial",
    });
    // Booked dividend — no "dividends" coverage row, so the dividend metric
    // reads unknown ("Not available") while the cash event is still counted.
    const divId = randomUUID();
    await tx.insert(schema.investmentActivityEvidence).values({
      id: divId,
      ownerId: userId,
      connectionId,
      syncRunId,
      accountId,
      instrumentId: aapl,
      source: "ibkr_flex",
      activityType: "dividend",
      idempotencyKey: Buffer.from("demo-aapl-dividend"),
      tradeDate: "2026-07-15",
      grossAmountCt: encText(dataKey, "12", divId, "gross_amount_ct", 1),
      netCashAmountCt: encText(dataKey, "12", divId, "net_cash_amount_ct", 1),
      currency: "USD",
      rawTypeCt: encText(dataKey, "Dividends", divId, "raw_type_ct", 1),
      provenance: "broker_reported",
    });
    // --- Unresolved disposal fixture: a ZGAP sale with no lot to close. ---
    const zgapSaleId = randomUUID();
    await tx.insert(schema.investmentActivityEvidence).values({
      id: zgapSaleId,
      ownerId: userId,
      connectionId,
      syncRunId,
      accountId,
      instrumentId: zgap,
      source: "ibkr_flex",
      activityType: "sell",
      idempotencyKey: Buffer.from("demo-zgap-sell"),
      tradeDate: "2026-07-01",
      quantityCt: encText(dataKey, "-5", zgapSaleId, "quantity_ct", 1),
      quantityUnit: "shares",
      grossAmountCt: encText(dataKey, "400", zgapSaleId, "gross_amount_ct", 1),
      netCashAmountCt: encText(dataKey, "400", zgapSaleId, "net_cash_amount_ct", 1),
      currency: "USD",
      rawTypeCt: encText(dataKey, "Trade", zgapSaleId, "raw_type_ct", 1),
      provenance: "broker_reported",
    });
  });

  // Genuine unresolved_disposal: derive replays the ZGAP scope and finds a sale
  // with no complete lot allocation.
  await deriveInvestmentTaxLots({ userId, accountId, instrumentId: zgap, dataKey });

  // --- Reconciliation gap fixture on VTI: a snapshot position (100) that
  //     exceeds the activity-derived lot quantity (60). ---
  const snapshotId = await withUser(userId, async (tx) => {
    const openingId = randomUUID();
    await tx.insert(schema.investmentOpeningLotEvidence).values({
      id: openingId,
      ownerId: userId,
      accountId,
      instrumentId: vti,
      idempotencyKey: Buffer.from("demo-vti-opening"),
      tradeDate: "2026-05-01",
      originalQuantityCt: encText(dataKey, "60", openingId, "original_quantity_ct", 1),
      remainingQuantityCt: encText(dataKey, "60", openingId, "remaining_quantity_ct", 1),
      quantityUnit: "shares",
      totalCostCt: encText(dataKey, "12000", openingId, "total_cost_ct", 1),
      currency: "USD",
      lockedFxProvenance: "unresolved",
      provenance: "user_entered",
    });
    const lotId = randomUUID();
    await tx.insert(schema.investmentTaxLots).values({
      id: lotId,
      ownerId: userId,
      accountId,
      instrumentId: vti,
      openingLotEvidenceId: openingId,
      derivationKey: Buffer.from("demo-vti-lot"),
      policyVersion: BROKER_ELSE_USER_POLICY_VERSION,
      tradeDate: "2026-05-01",
      originalQuantityCt: encText(dataKey, "60", lotId, "original_quantity_ct", 1),
      remainingQuantityCt: encText(dataKey, "60", lotId, "remaining_quantity_ct", 1),
      quantityUnit: "shares",
      costBasisCt: encText(dataKey, "12000", lotId, "cost_basis_ct", 1),
      costBasisCurrency: "USD",
      lockedFxProvenance: "unresolved",
      completeness: "complete",
    });
    await tx.insert(schema.investmentActivityCoverage).values({
      ownerId: userId,
      accountId,
      instrumentId: vti,
      source: "ibkr_flex",
      metric: "cost_basis",
      completeness: "complete",
    });
    const balanceSnapshotId = randomUUID();
    const detailId = randomUUID();
    await tx.insert(schema.accountBalanceSnapshots).values({
      id: balanceSnapshotId,
      ownerId: userId,
      accountId,
      date: "2026-07-24",
      source: "investment",
    });
    await tx.insert(schema.investmentSnapshotDetails).values({
      id: detailId,
      ownerId: userId,
      accountBalanceSnapshotId: balanceSnapshotId,
      accountId,
      connectionId,
      syncRunId,
      weekStart: weekStartSunday("2026-07-24"),
      source: "ibkr_flex",
      sourceAsOf: new Date("2026-07-24T12:00:00Z"),
      sourceAsOfPrecision: "timestamp",
      brokerTotalCt: encText(dataKey, "21140", detailId, "broker_total_ct", 1),
      brokerTotalCurrency: "USD",
      reconciliationState: "matched",
      validationVersion: 1,
    });
    // VTI position (100) exceeds the derived lot (60) — the reconciliation gap.
    // AAPL (6) matches its lot remaining, so it does NOT create a spurious gap.
    for (const [instrumentId, quantity, value] of [
      [vti, "100", "20000"],
      [aapl, "6", "1140"],
    ] as const) {
      const positionId = randomUUID();
      await tx.insert(schema.investmentSnapshotPositions).values({
        id: positionId,
        ownerId: userId,
        snapshotId: detailId,
        instrumentId,
        quantityCt: encText(dataKey, quantity, positionId, "quantity_ct", 1),
        quantityUnit: "shares",
        currency: "USD",
        sourceValueCt: encText(dataKey, value, positionId, "source_value_ct", 1),
        sourceValueCurrency: "USD",
        sourceAsOf: new Date("2026-07-24T12:00:00Z"),
        brokerValuationBasis: "market_value",
      });
    }
    return detailId;
  });

  // Genuine reconciliation_gap: snapshot qty (100) > lot-derived qty (60).
  await reconcileInvestmentActivity({ userId, accountId, snapshotId, dataKey });

  // --- Genuine identity_ambiguity: a fingerprint-keyed activity re-fetched with
  //     non-identical content is queued, not silently merged. ---
  const fingerprintActivity = {
    source: "ibkr_flex" as const,
    sourceAccountRef: "DEMO-IBKR",
    idempotencyKey: "DEMO-IBKR:fp:AMBIG-1",
    sourceSecurityId: "MSFT",
    sourceSecurityIdKind: "ibkr_conid",
    activityType: "dividend" as const,
    tradeDate: "2026-07-10",
    grossAmount: "30",
    netCashAmount: "30",
    currency: "USD",
    rawType: "Dividends",
    rawDescription: "MSFT dividend",
    provenance: "broker_reported" as const,
  };
  const evidenceSet = (netCashAmount: string) => ({
    activities: [{ ...fingerprintActivity, netCashAmount, grossAmount: netCashAmount }],
    openLots: [],
    dividendAccruals: [],
    corporateActions: [],
  });
  await ingestInvestmentActivityEvidence({
    userId,
    connectionId,
    syncRunId,
    dataKey,
    evidence: evidenceSet("30"),
  });
  await ingestInvestmentActivityEvidence({
    userId,
    connectionId,
    syncRunId,
    dataKey,
    evidence: evidenceSet("31"),
  });

  // The sync is finished; leave no perpetually-"running" run behind.
  await withUser(userId, async (tx) => {
    await tx
      .update(schema.syncRuns)
      .set({ status: "succeeded" })
      .where(eq(schema.syncRuns.id, syncRunId));
  });

  // Assert the pipeline actually produced every state, so a regression fails
  // the seed loudly instead of shipping an empty demo.
  await withUser(userId, async (tx) => {
    const queue = await tx
      .select({ kind: schema.investmentDisposalResolutionQueue.kind })
      .from(schema.investmentDisposalResolutionQueue)
      .where(eq(schema.investmentDisposalResolutionQueue.accountId, accountId));
    for (const kind of [
      "unresolved_disposal",
      "identity_ambiguity",
      "reconciliation_gap",
    ] as const) {
      if (!queue.some((row) => row.kind === kind))
        throw new Error(`seed: expected a ${kind} queue row for the investment demo`);
    }
    console.log(
      `  investment activity states: ${queue.length} queue rows (${[
        ...new Set(queue.map((row) => row.kind)),
      ].join(", ")})`,
    );
  });

  // The Schwab snapshot account (created earlier) has positions but no derived
  // cost basis; a partial cost_basis coverage row makes the portfolio Gains
  // figure read "Partial from known data" rather than merging down to unknown.
  await withUser(userId, async (tx) => {
    const others = await tx
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(
        and(eq(schema.accounts.ownerId, userId), eq(schema.accounts.accountType, "investment")),
      );
    for (const other of others) {
      if (other.id === accountId) continue;
      await tx.insert(schema.investmentActivityCoverage).values({
        ownerId: userId,
        accountId: other.id,
        source: "schwab_positions_csv",
        metric: "cost_basis",
        completeness: "partial",
      });
    }
  });

  // And that Performance now has at least one partial and one unknown metric to
  // render, plus a realized closure and a booked dividend.
  const portfolio = await readPortfolioInvestmentReturns({ userId, dataKey });
  const completeness = [
    portfolio.realizedGain.quality.completeness,
    portfolio.unrealizedGain.quality.completeness,
    portfolio.performance.twr.quality.completeness,
    portfolio.performance.mwr.quality.completeness,
    portfolio.dividendIncome.quality.completeness,
  ];
  if (!completeness.includes("partial"))
    throw new Error("seed: expected at least one partial completeness metric");
  if (!completeness.includes("unknown"))
    throw new Error("seed: expected at least one unknown completeness metric");
  if (portfolio.realizedGain.closureCount < 1)
    throw new Error("seed: expected a realized closure for the investment demo");
  if (portfolio.dividendIncome.bookedCashCount < 1)
    throw new Error("seed: expected a booked dividend for the investment demo");
  console.log(
    `  performance metrics: realized ${portfolio.realizedGain.ils.amount} ILS (${portfolio.realizedGain.quality.completeness}), ` +
      `dividends count ${portfolio.dividendIncome.bookedCashCount} (${portfolio.dividendIncome.quality.completeness})`,
  );
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
