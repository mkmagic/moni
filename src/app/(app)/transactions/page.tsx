import { requireSession } from "@/domain/auth";
import { requireOnboarded } from "@/domain/onboarding";
import { listEntries, NO_CATEGORY } from "@/domain/transactions";
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
 * isn't a well-formed value is dropped rather than passed through. */
const asDate = (v: string | undefined) => (v && ISO_DATE.test(v) ? v : undefined);
const asCategory = (v: string | undefined) =>
  v && (v === NO_CATEGORY || UUID.test(v)) ? v : undefined;

interface TransactionsPageProps {
  searchParams: Promise<{ category?: string; from?: string; to?: string }>;
}

export default async function TransactionsPage({ searchParams }: TransactionsPageProps) {
  const session = await requireSession();
  await requireOnboarded(session.userId);
  const params = await searchParams;

  // Date range and category are plaintext columns, so they narrow the window
  // in SQL rather than after decryption.
  const filters = {
    categoryId: asCategory(params.category),
    from: asDate(params.from),
    to: asDate(params.to),
  };

  const [entries, categories] = await Promise.all([
    listEntries(session, { ...filters, limit: WINDOW_SIZE }),
    listCategories(session),
  ]);

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
      windowSize={WINDOW_SIZE}
    />
  );
}
