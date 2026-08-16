import { requireSession } from "@/domain/auth";
import { requireOnboarded } from "@/domain/onboarding";
import { getProfile } from "@/domain/profile";
import { listEntries } from "@/domain/transactions";
import { israelDate } from "@/domain/investment-valuation";
import { NO_CATEGORY } from "@/lib/transactions/filters";
import type { Direction, SizeKey } from "@/lib/transactions/predicates";
import { listCategories, suggestCategories } from "@/domain/categorization";
import { TransactionsTable } from "@/components/transactions-table";

/** How many entries the server hands to the table. Search, amount range and
 * sort run in the browser over exactly this window (the payee and amount
 * columns are ciphertext in Postgres), so the table says so when it fills. */
const WINDOW_SIZE = 100;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A search param is user input reaching a SQL predicate. Drizzle parameterizes
 * it, but a malformed date or id still makes Postgres throw, so anything that
 * isn't a well-formed value is dropped rather than passed through.
 *
 * The shape check alone is not enough: `2026-99-99` matches the pattern and
 * still blows up the `date` column, so the value has to survive a round-trip
 * through `Date` as well. */
const asDate = (v: string | undefined) => {
  if (!v || !ISO_DATE.test(v)) return undefined;
  const parsed = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === v ? v : undefined;
};
const asCategory = (v: string | undefined) =>
  v && (v === NO_CATEGORY || UUID.test(v)) ? v : undefined;

const asDirection = (v: string | undefined): Direction =>
  v === "income" || v === "payment" ? v : "all";
const asSize = (v: string | undefined): SizeKey =>
  v === "s" || v === "m" || v === "l" ? v : "all";

interface TransactionsPageProps {
  searchParams: Promise<{
    category?: string;
    from?: string;
    to?: string;
    direction?: string;
    size?: string;
    scope?: string;
  }>;
}

export default async function TransactionsPage({ searchParams }: TransactionsPageProps) {
  const session = await requireSession();
  await requireOnboarded(session.userId);
  const params = await searchParams;

  // Date range and category are plaintext columns, so they narrow the window
  // in SQL rather than after decryption.
  const direction = asDirection(params.direction);
  const size = asSize(params.size);
  // Income/Payment and expense-size can't be SQL predicates (they read the
  // encrypted amount). By default they filter client-side over the window;
  // only when the user asks to "search entire history" (`scope=all`) does the
  // domain apply them completely, after decryption, before the window is
  // capped.
  const searchAll = params.scope === "all";
  const filters = {
    categoryId: asCategory(params.category),
    from: asDate(params.from),
    to: asDate(params.to),
    direction: searchAll ? direction : undefined,
    size: searchAll ? size : undefined,
  };

  // The Asia/Jerusalem calendar date, computed on the server so the timeframe
  // presets don't depend on the browser's clock (a hydration mismatch).
  const today = israelDate(new Date());

  // One row past the window, so "there is more behind this" is something the
  // page knows rather than infers: a user with exactly WINDOW_SIZE matching
  // entries would otherwise be told to narrow a range that hides nothing.
  const [window, categories, profile] = await Promise.all([
    listEntries(session, { ...filters, limit: WINDOW_SIZE + 1 }),
    listCategories(session),
    getProfile(session.userId),
  ]);
  const capped = window.length > WINDOW_SIZE;
  const entries = capped ? window.slice(0, WINDOW_SIZE) : window;

  // Only the uncategorized rows can carry a suggestion — layers 0-2 already
  // spoke for the rest, and a locked field is nobody else's business.
  const suggestions = await suggestCategories(
    session,
    entries
      .filter((e) => e.categoryId === null && !e.categoryLocked)
      .map((e) => ({ id: e.id, matchText: e.matchText })),
  );

  return (
    <TransactionsTable
      entries={entries}
      categories={categories}
      suggestions={suggestions}
      serverFilters={{
        category: filters.categoryId ?? "",
        from: filters.from ?? "",
        to: filters.to ?? "",
      }}
      viewFilters={{ direction, size }}
      searchAll={searchAll}
      today={today}
      windowSize={WINDOW_SIZE}
      capped={capped}
      smartCategorizeEnabled={Boolean(profile?.smartCategorize)}
    />
  );
}
