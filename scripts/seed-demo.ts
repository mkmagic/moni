// Demo/dev fixture data for Moni (T5). Wipes and reseeds a small family of
// users with accounts, categories, a few months of ledger entries, a
// recurring subscription, an internal transfer, and balance snapshots — just
// enough to build the overview dashboard against. See docs/design/data-model.md
// §5 for what each table means and docs/design/money-and-currency.md for the
// currency-triple / locked-FX-rate rules this data must stay consistent with.
//
// DEV ONLY. Uses the dev key provider (src/lib/crypto/dev-key-provider.ts) —
// never a production key-custody path.
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { eq } from "drizzle-orm";
import Decimal from "decimal.js";
import { withUser } from "@/db/client";
import * as schema from "@/db/schema";
import { encryptField, decryptField, getDevUserDataKey, type AadContext } from "@/lib/crypto";
import { multiply } from "@/lib/money";

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
      entry_field_changelog, entry_transactions, entries, transfers, recurring_series,
      rule_actions, rule_conditions, rules, sync_staging, sync_runs, connections,
      account_balance_snapshots, credit_card_details, accounts, merchants, categories,
      fx_rates, users
    CASCADE
  `);
}

// ---------------------------------------------------------------------------
// 2. fx_rates (global reference data, no owner_id — moni_app is SELECT-only
//    per the T3 grants, so this also goes through the elevated connection).
//    A handful of representative ILS<->USD dates spanning the entries below.
// ---------------------------------------------------------------------------
const FX_SOURCE = "demo-fixed";
const FX_DATES_USD_ILS: Array<{ date: string; rate: string }> = [
  { date: "2026-05-01", rate: "3.70" },
  { date: "2026-05-15", rate: "3.72" },
  { date: "2026-06-01", rate: "3.68" },
  { date: "2026-06-15", rate: "3.71" },
  { date: "2026-07-01", rate: "3.73" },
  { date: "2026-07-15", rate: "3.75" },
];
/** Rate lookup entries reuse so entries.fxRate is honestly "a real locked rate from
 * the seeded fx_rates table," not a coincidentally-matching separate number. */
const fxRateByDate = new Map(FX_DATES_USD_ILS.map((r) => [r.date, r.rate]));

async function seedFxRates(owner: Client): Promise<number> {
  let count = 0;
  for (const { date, rate } of FX_DATES_USD_ILS) {
    await owner.query(
      `INSERT INTO fx_rates (id, from_currency, to_currency, date, rate, source)
       VALUES ($1, 'USD', 'ILS', $2, $3, $4)`,
      [randomUUID(), date, rate, FX_SOURCE],
    );
    count++;
    const inverse = new Decimal(1).dividedBy(new Decimal(rate)).toDecimalPlaces(6).toString();
    await owner.query(
      `INSERT INTO fx_rates (id, from_currency, to_currency, date, rate, source)
       VALUES ($1, 'ILS', 'USD', $2, $3, $4)`,
      [randomUUID(), date, inverse, FX_SOURCE],
    );
    count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// 3. Per-user fixture definition. Everything below is written through
//    withUser(userId, ...) — a real exercise of the RLS-scoped write path,
//    not a bypass (security-design-principles.md §9-11).
// ---------------------------------------------------------------------------
interface UserPlan {
  id: string;
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
    id: randomUUID(),
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
    id: randomUUID(),
    email: "yossi@moni.demo",
    displayName: "Yossi",
    checkingName: "Bank Hapoalim Checking",
    checkingInstitution: "Bank Hapoalim",
    creditCardName: "Max Credit Card",
    creditCardInstitution: "Max",
    thirdAccount: {
      type: "investment",
      name: "IBKR Brokerage",
      institution: "Interactive Brokers",
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
  recurringSeries: number;
  transfers: number;
  accountBalanceSnapshots: number;
}

async function seedUser(plan: UserPlan, counts: SeedCounts): Promise<void> {
  const dataKey = getDevUserDataKey(plan.id);

  await withUser(plan.id, async (tx) => {
    // --- users -------------------------------------------------------
    await tx.insert(schema.users).values({
      id: plan.id,
      email: plan.email,
      baseCurrency: "ILS",
    });
    counts.users++;

    // --- categories ----------------------------------------------------
    const categoryDefs = [
      { key: "salary", name: "Salary", classification: "income" as const },
      { key: "groceries", name: "Groceries", classification: "expense" as const },
      { key: "transport", name: "Transport", classification: "expense" as const },
      { key: "rent", name: "Rent & Housing", classification: "expense" as const },
      { key: "entertainment", name: "Entertainment", classification: "expense" as const },
    ];
    const categoryIds: Record<string, string> = {};
    for (const c of categoryDefs) {
      const id = randomUUID();
      categoryIds[c.key] = id;
      await tx.insert(schema.categories).values({
        id,
        ownerId: plan.id,
        name: c.name,
        classification: c.classification,
      });
      counts.categories++;
    }

    // --- merchants -------------------------------------------------------
    const shufersalId = randomUUID();
    const netflixId = randomUUID();
    await tx.insert(schema.merchants).values([
      {
        id: shufersalId,
        ownerId: plan.id,
        nameCt: enc(dataKey, shufersalId, "name_ct", "Shufersal"),
        source: "manual",
      },
      {
        id: netflixId,
        ownerId: plan.id,
        nameCt: enc(dataKey, netflixId, "name_ct", "Netflix"),
        source: "manual",
      },
    ]);
    counts.merchants += 2;

    // --- accounts -------------------------------------------------------
    const checkingId = randomUUID();
    const creditCardId = randomUUID();
    const thirdAccountId = randomUUID();

    const checkingBalance = "22000.00";
    const creditCardBalance = "-2350.40";

    await tx.insert(schema.accounts).values([
      {
        id: checkingId,
        ownerId: plan.id,
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
        ownerId: plan.id,
        accountType: "credit_card",
        classification: "liability",
        nameCt: enc(dataKey, creditCardId, "name_ct", plan.creditCardName),
        institution: plan.creditCardInstitution,
        accountNumberLast4Ct: enc(dataKey, creditCardId, "account_number_last4_ct", "7734"),
        currency: "ILS",
        currentBalanceCt: enc(dataKey, creditCardId, "current_balance_ct", creditCardBalance),
      },
      {
        id: thirdAccountId,
        ownerId: plan.id,
        accountType: plan.thirdAccount.type,
        classification: "asset",
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
    ]);
    counts.accounts += 3;

    // --- credit_card_details ---------------------------------------------
    await tx.insert(schema.creditCardDetails).values({
      accountId: creditCardId,
      ownerId: plan.id,
      statementCloseDay: 10,
      paymentDueDay: 25,
      creditLimitCt: enc(dataKey, creditCardId, "credit_limit_ct", "20000.00"),
    });
    counts.creditCardDetails++;

    // --- account_balance_snapshots (one per account, "as of today") ------
    const snapshotDefs = [
      { accountId: checkingId, amount: checkingBalance, currency: "ILS" },
      { accountId: creditCardId, amount: creditCardBalance, currency: "ILS" },
      {
        accountId: thirdAccountId,
        amount: plan.thirdAccount.balance,
        currency: plan.thirdAccount.currency,
      },
    ];
    for (const s of snapshotDefs) {
      const id = randomUUID();
      await tx.insert(schema.accountBalanceSnapshots).values({
        id,
        ownerId: plan.id,
        accountId: s.accountId,
        date: TODAY,
        nativeBalanceCt: enc(dataKey, id, "native_balance_ct", s.amount),
        currency: s.currency,
        source: "manual",
      });
      counts.accountBalanceSnapshots++;
    }

    // --- recurring_series (Netflix subscription) --------------------------
    const recurringSeriesId = randomUUID();
    const netflixAmount = "-49.90";
    await tx.insert(schema.recurringSeries).values({
      id: recurringSeriesId,
      ownerId: plan.id,
      merchantId: netflixId,
      categoryId: categoryIds.entertainment,
      cadence: "monthly",
      expectedAmountCt: enc(dataKey, recurringSeriesId, "expected_amount_ct", netflixAmount),
      nextExpectedDate: addDays(TODAY, 7),
      isSubscription: true,
      status: "active",
    });
    counts.recurringSeries++;

    // --- entries + entry_transactions ------------------------------------
    interface EntryDef {
      date: string;
      description: string;
      accountId: string;
      categoryId?: string;
      merchantId?: string;
      recurringSeriesId?: string;
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
          description: "Shufersal grocery run",
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
        description: "Netflix subscription",
        accountId: creditCardId,
        categoryId: categoryIds.entertainment,
        merchantId: netflixId,
        recurringSeriesId,
        enteredAmount: netflixAmount,
        enteredCurrency: "ILS",
        accountAmount: netflixAmount,
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
        fxSource: FX_SOURCE,
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
        ownerId: plan.id,
        accountId: def.accountId,
        entryType: "transaction",
        date: def.date,
        descriptionCt: enc(dataKey, id, "description_ct", def.description),
        notesCt: def.notes ? enc(dataKey, id, "notes_ct", def.notes) : null,
        categoryId: def.categoryId ?? null,
        merchantId: def.merchantId ?? null,
        recurringSeriesId: def.recurringSeriesId ?? null,
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
        ownerId: plan.id,
        kind: def.kind,
      });
      counts.entryTransactions++;
    }

    // --- transfers ---------------------------------------------------------
    await tx.insert(schema.transfers).values({
      id: randomUUID(),
      ownerId: plan.id,
      inflowEntryId: inflowId,
      outflowEntryId: outflowId,
      status: "completed",
    });
    counts.transfers++;
  });
}

// ---------------------------------------------------------------------------
// 4. Decrypt round-trip proof — reads one seeded field back through the
//    normal RLS-scoped path and decrypts it with the same AAD used to
//    encrypt, proving the ciphertext is honest, not opaque filler.
// ---------------------------------------------------------------------------
async function proveRoundTrip(plan: UserPlan): Promise<{ field: string; value: string }> {
  const dataKey = getDevUserDataKey(plan.id);
  return withUser(plan.id, async (tx) => {
    const [account] = await tx
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.ownerId, plan.id))
      .limit(1);
    if (!account) throw new Error("Round-trip check: no account found");
    const plaintext = decryptField(dataKey, account.nameCt, {
      rowId: account.id,
      column: "name_ct",
      version: account.version,
    });
    return { field: `accounts.name_ct (${plan.email})`, value: plaintext.toString("utf8") };
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
    recurringSeries: 0,
    transfers: 0,
    accountBalanceSnapshots: 0,
  };

  try {
    console.log("Wiping existing data...");
    await wipeAll(owner);

    console.log("Seeding fx_rates...");
    const fxRateCount = await seedFxRates(owner);

    for (const plan of USERS) {
      console.log(`Seeding user ${plan.displayName} (${plan.email})...`);
      await seedUser(plan, counts);
    }

    console.log("\nVerifying encryption round-trip...");
    const roundTrips = await Promise.all(USERS.map(proveRoundTrip));

    console.log("\n=== Seed summary ===");
    for (const plan of USERS) {
      console.log(`- ${plan.displayName}: ${plan.email} (id ${plan.id})`);
    }
    console.log(`fx_rates: ${fxRateCount}`);
    console.log(`users: ${counts.users}`);
    console.log(`categories: ${counts.categories}`);
    console.log(`merchants: ${counts.merchants}`);
    console.log(`accounts: ${counts.accounts}`);
    console.log(`credit_card_details: ${counts.creditCardDetails}`);
    console.log(`entries: ${counts.entries}`);
    console.log(`entry_transactions: ${counts.entryTransactions}`);
    console.log(`recurring_series: ${counts.recurringSeries}`);
    console.log(`transfers: ${counts.transfers}`);
    console.log(`account_balance_snapshots: ${counts.accountBalanceSnapshots}`);
    console.log("\nDecrypt round-trip proof:");
    for (const rt of roundTrips) {
      console.log(`- ${rt.field} -> "${rt.value}"`);
    }
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
