import { requireSession } from "@/domain/auth";
import { requireOnboarded } from "@/domain/onboarding";
import { listEntries } from "@/domain/transactions";
import { listCategories, suggestCategories } from "@/domain/categorization";
import { TransactionsTable } from "@/components/transactions-table";

export default async function TransactionsPage() {
  const session = await requireSession();
  await requireOnboarded(session.userId);
  const [entries, categories] = await Promise.all([
    listEntries(session, { limit: 100 }),
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

  return <TransactionsTable entries={entries} categories={categories} suggestions={suggestions} />;
}
