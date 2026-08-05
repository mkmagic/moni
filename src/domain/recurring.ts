// Domain read: the recurring view (#15). Nothing here is stored — a merchant
// is recurring because the user flagged its category, and every number below
// is derived from `entries` on each render (docs/adr/0006-*).
//
// Two rules carried over from the rest of the app, both easy to get wrong in
// a new aggregate:
//   * `countsAsFlow` decides what belongs in a total (flows.ts).
//   * An entry with no locked FX rate is skipped, never valued at 1:1
//     (dashboard.ts, money-and-currency.md §4).
import Decimal from "decimal.js";
import { inArray } from "drizzle-orm";
import { withUser } from "@/db/client";
import { categories, entries, merchants } from "@/db/schema";
import { abs, add, divide, multiply, type Money } from "@/lib/money";
import { normalizeDescription } from "@/lib/categorization/normalize";
import { matchCatalog, merchantIdentity } from "@/lib/merchants/catalog";
import {
  CADENCE_MONTHS,
  asSettableCadence,
  deriveCadence,
  type Cadence,
} from "@/lib/recurring/cadence";
import type { Session } from "@/lib/auth/session-store";
import { decText } from "./fields";
import { countsAsFlow, loadTransferCategoryIds } from "./flows";

// The range vocabulary lives in `lib` so client components can import it
// without pulling `pg` into the browser bundle (see its header).
import { RANGE_LABELS, RANGE_MONTHS, type RecurringRange } from "@/lib/recurring/range";

export type { RecurringRange };

/** Formatted server-side with an explicit locale, as transactions.ts does. */
const DATE_LABEL = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });
const MONTH_LABEL = new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric" });

export interface RecurringPayment {
  date: string;
  dateLabel: string;
  /** Positive magnitude — the section says whether it was earned or spent. */
  amount: Money;
}

export interface RecurringRow {
  /** Stable within a render; the merchant row's id when one exists. */
  id: string;
  merchantId: string | null;
  /** The payee's match text — what a cadence override is keyed by, since a
   * row may predate its merchant row (docs/adr/0005-*). */
  matchText: string;
  merchantName: string;
  /** Origin-local path or null — never external (docs/adr/0007-*). */
  logoUrl: string | null;
  /** Tints the monogram when there is no logo. */
  brandColor: string | null;
  cadence: Cadence;
  /** True when the user set the cadence by hand rather than the dates implying it. */
  cadenceIsOverride: boolean;
  /** What they pay now. */
  latest: Money;
  /** Mean of the last three payments — or of however many exist below three. */
  averageOfLast3: Money;
  /** What this payee costs per month: `averageOfLast3` divided by the number
   * of months one payment covers. Equal to `averageOfLast3` for a monthly
   * payee; a twelfth of it for an annual one. This is the figure a budget is
   * built from, and the only one that can be summed across cadences. */
  monthlyAverage: Money;
  /** True when the cadence is `irregular`/`unknown`, so `monthlyAverage` had
   * to be derived from the span of the payments rather than from a period.
   * Display it hedged. */
  monthlyAverageIsEstimate: boolean;
  paymentCount: number;
  firstSeen: string;
  /** "since Aug 2025", pre-formatted. */
  firstSeenLabel: string;
  /** Every payment, oldest first. The graph's own control counts payments, not months. */
  payments: RecurringPayment[];
}

export interface RecurringGroup {
  categoryId: string;
  categoryName: string;
  /** Sum of this category's qualifying entries **within the selected range**. */
  total: Money;
  /** Sum of the rows' `monthlyAverage`. Unlike `total` it does not move when
   * the range control does, which is what makes it the number to budget
   * against: a six-month range showed a monthly ₪613 subscription as ₪3,679
   * and there was no way to tell the two apart. */
  monthlyAverage: Money;
  /** True when any row's monthly figure is an estimate. */
  monthlyAverageIsEstimate: boolean;
  rows: RecurringRow[];
}

export interface RecurringView {
  baseCurrency: string;
  range: RecurringRange;
  rangeLabel: string;
  /** Kept apart on purpose: a combined total of the two is meaningless. */
  income: RecurringGroup[];
  expenses: RecurringGroup[];
}

/** First day of the range, or null for "all". */
function rangeStart(range: RecurringRange, today: string): string | null {
  if (range === "all") return null;
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - RANGE_MONTHS[range]);
  return d.toISOString().slice(0, 10);
}

interface Payment {
  date: string;
  /** Signed reporting amount. */
  amount: Money;
}

interface Bucket {
  identity: string;
  matchText: string;
  payments: Payment[];
  /** The category of the most recent payment — where the row files. */
  categoryId: string;
  latestDate: string;
}

export async function getRecurringView(
  session: Session,
  opts: { range: RecurringRange } = { range: "6m" },
): Promise<RecurringView> {
  const { userId, dataKey, baseCurrency } = session;
  const today = new Date().toISOString().slice(0, 10);
  const start = rangeStart(opts.range, today);

  return withUser(userId, async (tx) => {
    const catRows = await tx
      .select({
        id: categories.id,
        name: categories.name,
        parentId: categories.parentId,
        classification: categories.classification,
        isRecurring: categories.isRecurring,
      })
      .from(categories);

    // A flag on a parent covers its children, matching how a parent already
    // filters entries (transactions.ts).
    const flagged = new Set(catRows.filter((c) => c.isRecurring).map((c) => c.id));
    const recurring = catRows.filter(
      (c) => flagged.has(c.id) || (c.parentId !== null && flagged.has(c.parentId)),
    );
    if (recurring.length === 0) {
      return { baseCurrency, range: opts.range, rangeLabel: RANGE_LABELS[opts.range], income: [], expenses: [] }; // prettier-ignore
    }

    const recurringIds = recurring.map((c) => c.id);
    const transferCategoryIds = await loadTransferCategoryIds(tx);

    // All history, not just the range: a row's headline, cadence and payment
    // count are statements about the whole series (docs/adr/0006-*).
    const entryRows = await tx
      .select()
      .from(entries)
      .where(inArray(entries.categoryId, recurringIds));

    const buckets = new Map<string, Bucket>();
    const totals = new Map<string, Money>();

    for (const e of entryRows) {
      if (!countsAsFlow(e, transferCategoryIds)) continue;
      if (e.fxStatus === "pending" || !e.fxRate) continue; // never fake a rate
      const description = decText(dataKey, e.descriptionCt, e.id, "description_ct", e.version);
      const entered = decText(dataKey, e.enteredAmountCt, e.id, "entered_amount_ct", e.version);
      if (description === null || entered === null) continue;

      const reporting: Money = {
        amount: multiply({ amount: entered, currency: e.enteredCurrency }, e.fxRate).amount,
        currency: e.reportingCurrency,
      };

      // Category totals follow the range; everything else does not.
      if (start === null || e.date >= start) {
        const key = e.categoryId as string;
        const magnitude = abs(reporting);
        totals.set(key, totals.get(key) ? add(totals.get(key) as Money, magnitude) : magnitude);
      }

      const matchText = normalizeDescription(description);
      if (matchText === "") continue;
      const identity = merchantIdentity(matchText);

      const bucket = buckets.get(identity) ?? {
        identity,
        matchText,
        payments: [],
        categoryId: e.categoryId as string,
        latestDate: e.date,
      };
      bucket.payments.push({ date: e.date, amount: reporting });
      if (e.date >= bucket.latestDate) {
        bucket.latestDate = e.date;
        bucket.categoryId = e.categoryId as string;
      }
      buckets.set(identity, bucket);
    }

    // Merchant rows supply the display name, the icon and the cadence
    // override — presentation, not identity. Decrypted once and indexed by
    // the same identity the buckets use.
    const merchantRows = await tx.select().from(merchants);
    const merchantByIdentity = new Map<string, (typeof merchantRows)[number]>();
    for (const m of merchantRows) {
      const mt = decText(dataKey, m.matchTextCt, m.id, "match_text_ct", m.version);
      if (mt === null) continue;
      merchantByIdentity.set(merchantIdentity(mt), m);
    }

    const rowsByCategory = new Map<string, RecurringRow[]>();
    for (const bucket of buckets.values()) {
      const row = toRow(bucket, dataKey, merchantByIdentity.get(bucket.identity));
      const list = rowsByCategory.get(bucket.categoryId) ?? [];
      list.push(row);
      rowsByCategory.set(bucket.categoryId, list);
    }

    const groups = (classification: "income" | "expense"): RecurringGroup[] =>
      recurring
        .filter((c) => c.classification === classification)
        .map((c) => {
          // Biggest first, name as the tie-break. Compared through decimal.js
          // — a JS number is never allowed to touch a money value, not even
          // to sort it (AGENTS.md).
          const rows = (rowsByCategory.get(c.id) ?? []).sort((a, b) => {
            const bySize = new Decimal(b.latest.amount).comparedTo(new Decimal(a.latest.amount));
            return bySize !== 0 ? bySize : a.merchantName.localeCompare(b.merchantName);
          });
          return {
            categoryId: c.id,
            categoryName: c.name,
            total: totals.get(c.id) ?? { amount: "0", currency: baseCurrency },
            monthlyAverage: rows.reduce((acc, row) => add(acc, row.monthlyAverage), {
              amount: "0",
              currency: baseCurrency,
            } as Money),
            monthlyAverageIsEstimate: rows.some((row) => row.monthlyAverageIsEstimate),
            rows,
          };
        })
        .filter((g) => g.rows.length > 0);

    return {
      baseCurrency,
      range: opts.range,
      rangeLabel: RANGE_LABELS[opts.range],
      income: groups("income"),
      expenses: groups("expense"),
    };
  });
}

/**
 * A monthly figure for a payee whose cadence has no period — everything paid
 * so far, spread across the calendar months it was paid over.
 *
 * Deliberately counts calendar months rather than day-spans: two payments on
 * the 1st of January and the 1st of March cover three months of the user's
 * life, not two, and a budget is kept in calendar months. A single payment
 * spreads over one month, which overstates a rare charge — that is why the
 * caller flags this branch as an estimate rather than presenting it flat.
 *
 * `payments` must be sorted oldest-first and non-empty; `toRow` guarantees both.
 */
function spreadOverObservedMonths(payments: RecurringPayment[]): Money {
  const first = payments[0].date;
  const last = payments[payments.length - 1].date;
  const months =
    (Number(last.slice(0, 4)) - Number(first.slice(0, 4))) * 12 +
    (Number(last.slice(5, 7)) - Number(first.slice(5, 7))) +
    1;
  const total = payments.reduce((acc, p) => add(acc, p.amount), {
    amount: "0",
    currency: payments[0].amount.currency,
  } as Money);
  return divide(total, String(months));
}

function toRow(
  bucket: Bucket,
  dataKey: Uint8Array,
  merchant: { id: string; nameCt: Buffer; logoUrl: string | null; cadenceOverride: string | null; version: number } | undefined, // prettier-ignore
): RecurringRow {
  const payments = [...bucket.payments].sort((a, b) => a.date.localeCompare(b.date));
  const magnitudes: RecurringPayment[] = payments.map((p) => ({
    date: p.date,
    dateLabel: DATE_LABEL.format(new Date(p.date)),
    amount: abs(p.amount),
  }));

  const lastThree = magnitudes.slice(-3);
  const sum = lastThree.reduce((acc, p) => add(acc, p.amount), {
    amount: "0",
    currency: lastThree[0].amount.currency,
  } as Money);

  const catalog = matchCatalog(bucket.matchText);
  const override = asSettableCadence(merchant?.cadenceOverride ?? null);
  const firstSeen = magnitudes[0].date;
  const cadence = override ?? deriveCadence(magnitudes.map((p) => p.date));
  const averageOfLast3 = divide(sum, String(lastThree.length));
  const period = cadence === "irregular" || cadence === "unknown" ? null : CADENCE_MONTHS[cadence];

  return {
    id: merchant?.id ?? bucket.identity,
    merchantId: merchant?.id ?? null,
    matchText: bucket.matchText,
    merchantName:
      (merchant && decText(dataKey, merchant.nameCt, merchant.id, "name_ct", merchant.version)) ||
      catalog?.name ||
      bucket.matchText,
    logoUrl: merchant?.logoUrl ?? catalog?.logoPath ?? null,
    brandColor: catalog?.brandColor ?? null,
    cadence,
    cadenceIsOverride: override != null,
    latest: magnitudes[magnitudes.length - 1].amount,
    averageOfLast3,
    monthlyAverage:
      period === null
        ? spreadOverObservedMonths(magnitudes)
        : divide(averageOfLast3, String(period)),
    monthlyAverageIsEstimate: period === null,
    paymentCount: magnitudes.length,
    firstSeen,
    firstSeenLabel: `since ${MONTH_LABEL.format(new Date(firstSeen))}`,
    payments: magnitudes,
  };
}
