// Domain read: ledger entries (transactions), decrypted and reporting-valued.
// Filters on plaintext structural columns (date, account), decrypts the
// narrowed set, and derives the reporting amount = entered × locked fx_rate
// (data-model.md §4.3). Pending-FX entries are flagged, never faked to 1:1
// (money-and-currency.md §4).
import { and, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { withUser } from "@/db/client";
import { accounts, categories, entries, entryTransactions, merchants } from "@/db/schema";
import { multiply, type Money } from "@/lib/money";
import type { Session } from "@/lib/auth/session-store";
import { normalizeDescription } from "@/lib/categorization/normalize";
// Defined in `lib` so the transactions toolbar can import it without dragging
// this module — and `pg` — into the client bundle. See its header.
import { NO_CATEGORY } from "@/lib/transactions/filters";
import {
  matchesDirection,
  matchesSize,
  type Direction,
  type SizeKey,
} from "@/lib/transactions/predicates";
import { decText } from "./fields";
import { isFieldLocked } from "./attribute-locks";
import { loadTransferCategoryIds } from "./flows";

/** Formatted here, on the server, with an explicit locale — a client
 * component that called `toLocaleDateString()` on the raw ISO string would
 * hydrate differently than it rendered (.agents/skills/ui-developer). */
const DATE_LABEL = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });

export interface EntryView {
  id: string;
  date: string;
  /** Pre-formatted for display; safe to render inside a client component. */
  dateLabel: string;
  description: string;
  /** The normalized description — what an "apply to future" rule matches on.
   * Computed here so the UI never has to re-derive merchant identity. */
  matchText: string;
  accountId: string;
  accountName: string;
  categoryId: string | null;
  categoryName: string | null;
  /** True once a human set the category — rules and the model skip it forever. */
  categoryLocked: boolean;
  /** The category is classified `transfer`: money moved, not earned or spent.
   * The UI colors these blue rather than teal/coral, because the sign of a
   * transfer is not good or bad news (`src/domain/flows.ts`). */
  isTransfer: boolean;
  merchantName: string | null;
  /** "3/12" when this entry is one payment of an installment deal, else null.
   * The row's amount is that payment alone, and its date is when that payment
   * is charged, so without the label a twelve-payment purchase reads as
   * twelve unrelated charges. */
  installmentLabel: string | null;
  /** Reporting (base-currency) amount when the rate is locked; the entered leg when pending. Sign carried. */
  amount: Money;
  /** True when no locked FX rate exists yet — amount is the entered leg, not reporting. */
  fxPending: boolean;
  excluded: boolean;
  status: string;
}

export interface EntryFilters {
  from?: string;
  to?: string;
  accountId?: string;
  /** Restrict to one merchant. Plaintext-column filter like `accountId`; the
   * MCP surface resolves a (DK-decrypted) merchant name to its id first. */
  merchantId?: string;
  /** A category id, or `NO_CATEGORY` for entries with none. A parent category
   * also matches everything filed under its children. This is a statement
   * about the category column and nothing else — unlike `uncategorized`, it
   * keeps excluded entries. */
  categoryId?: string;
  limit?: number;
  /** The review queue: entries with no category yet. Excluded entries (one
   * leg of an internal transfer) are left out — they are not "needing
   * review", they are deliberately out of the totals. */
  uncategorized?: boolean;
  /** Income/Payment and expense-size filters. Both depend on the decrypted
   * amount, so they cannot be SQL predicates; when set, they are applied here
   * after decryption, before `limit` truncates — so the result is the newest
   * matches, not the newest rows filtered (issue #107). Left unset, they cost
   * nothing and the read is unchanged. */
  direction?: Direction;
  size?: SizeKey;
}

/** When Income/Payment or size is active, the scan reaches past the display
 * `limit` so the filter sees the whole range, not just the newest page. Capped
 * so a filter over "everything" can't decrypt an unbounded ledger into memory;
 * a range wider than this is complete for its most recent `POST_FILTER_SCAN_CAP`
 * entries, which pairing the search with a timeframe keeps well clear of. */
const POST_FILTER_SCAN_CAP = 2000;

export async function listEntries(
  session: Session,
  filters: EntryFilters = {},
): Promise<EntryView[]> {
  const { userId, dataKey } = session;
  return withUser(userId, async (tx) => {
    // Read before the entries query, not after: a category filter has to know
    // the tree before it can build its predicate. Reused below for names.
    const catRows = await tx
      .select({ id: categories.id, name: categories.name, parentId: categories.parentId })
      .from(categories);

    const conds = [];
    if (filters.from) conds.push(gte(entries.date, filters.from));
    if (filters.to) conds.push(lte(entries.date, filters.to));
    if (filters.accountId) conds.push(eq(entries.accountId, filters.accountId));
    if (filters.merchantId) conds.push(eq(entries.merchantId, filters.merchantId));
    if (filters.categoryId) {
      const { categoryId } = filters;
      conds.push(
        categoryId === NO_CATEGORY
          ? isNull(entries.categoryId)
          : // A parent is a heading, not a label — entries are filed under its
            // children, so an equality test on "Income" matches nothing at
            // all. The id itself stays in the list because nothing stops a
            // childless top-level category from being assigned directly.
            inArray(entries.categoryId, [
              categoryId,
              ...catRows.filter((c) => c.parentId === categoryId).map((c) => c.id),
            ]),
      );
    }
    if (filters.uncategorized) {
      conds.push(isNull(entries.categoryId));
      conds.push(eq(entries.excluded, false));
    }

    // A decrypt-time filter has to see more than one page, or it would filter
    // the newest `limit` rows and call the leftovers complete.
    const postFilter =
      (filters.direction !== undefined && filters.direction !== "all") ||
      (filters.size !== undefined && filters.size !== "all");

    const rows = await tx
      .select()
      .from(entries)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(entries.date))
      .limit(postFilter ? POST_FILTER_SCAN_CAP : (filters.limit ?? 200));

    // Name lookups (small per-user tables; decrypt once, map by id).
    const acctRows = await tx
      .select({ id: accounts.id, nameCt: accounts.nameCt, version: accounts.version })
      .from(accounts);
    const acctName = new Map(
      acctRows.map((a) => [a.id, decText(dataKey, a.nameCt, a.id, "name_ct", a.version) ?? ""]),
    );

    const catName = new Map(catRows.map((c) => [c.id, c.name]));
    const transferCategoryIds = await loadTransferCategoryIds(tx);

    // Installment slice metadata for exactly the rows on screen — plaintext
    // columns only, so no decryption and no second pass over the ledger.
    const sliceRows = rows.length
      ? await tx
          .select({
            entryId: entryTransactions.entryId,
            number: entryTransactions.installmentNumber,
            total: entryTransactions.totalInstallments,
          })
          .from(entryTransactions)
          .where(
            inArray(
              entryTransactions.entryId,
              rows.map((r) => r.id),
            ),
          )
      : [];
    const installmentLabel = new Map(
      sliceRows
        .filter((r) => r.number != null && r.total != null)
        .map((r) => [r.entryId, `${r.number}/${r.total}`]),
    );

    const merRows = await tx
      .select({ id: merchants.id, nameCt: merchants.nameCt, version: merchants.version })
      .from(merchants);
    const merName = new Map(
      merRows.map((m) => [m.id, decText(dataKey, m.nameCt, m.id, "name_ct", m.version) ?? ""]),
    );

    const views = rows.map((e): EntryView => {
      const description =
        decText(dataKey, e.descriptionCt, e.id, "description_ct", e.version) ?? "";
      const entered =
        decText(dataKey, e.enteredAmountCt, e.id, "entered_amount_ct", e.version) ?? "0";
      const fxPending = e.fxStatus === "pending" || !e.fxRate;
      const amount: Money = fxPending
        ? { amount: entered, currency: e.enteredCurrency }
        : {
            amount: multiply({ amount: entered, currency: e.enteredCurrency }, e.fxRate as string)
              .amount,
            currency: e.reportingCurrency,
          };
      return {
        id: e.id,
        date: e.date,
        dateLabel: DATE_LABEL.format(new Date(e.date)),
        description,
        matchText: normalizeDescription(description),
        accountId: e.accountId,
        accountName: acctName.get(e.accountId) ?? "—",
        categoryId: e.categoryId,
        categoryName: e.categoryId ? (catName.get(e.categoryId) ?? null) : null,
        categoryLocked: isFieldLocked(e.lockedAttributes, "category_id"),
        isTransfer: e.categoryId !== null && transferCategoryIds.has(e.categoryId),
        merchantName: e.merchantId ? (merName.get(e.merchantId) ?? null) : null,
        installmentLabel: installmentLabel.get(e.id) ?? null,
        amount,
        fxPending,
        excluded: e.excluded,
        status: e.status,
      };
    });

    if (!postFilter) return views;
    const matched = views.filter(
      (v) =>
        matchesDirection(v, filters.direction ?? "all") && matchesSize(v, filters.size ?? "all"),
    );
    return filters.limit === undefined ? matched : matched.slice(0, filters.limit);
  });
}
