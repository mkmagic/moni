import { requireSession } from "@/domain/auth";
import { requireOnboarded } from "@/domain/onboarding";
import { listEntries } from "@/domain/transactions";
import { listCategories } from "@/domain/categorization";
import { TransactionsTable } from "@/components/transactions-table";

export default async function TransactionsPage() {
  const session = await requireSession();
  await requireOnboarded(session.userId);
  const [entries, categories] = await Promise.all([
    listEntries(session, { limit: 100 }),
    listCategories(session),
  ]);

  return <TransactionsTable entries={entries} categories={categories} />;
}
