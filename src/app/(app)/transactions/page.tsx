import { requireSession } from "@/domain/auth";
import { requireOnboarded } from "@/domain/onboarding";
import { listEntries } from "@/domain/transactions";
import { TransactionsTable } from "@/components/transactions-table";

export default async function TransactionsPage() {
  const session = await requireSession();
  await requireOnboarded(session.userId);
  const entries = await listEntries(session, { limit: 100 });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Transactions</h1>
        <p className="text-sm text-muted-foreground">Your latest income and expenses</p>
      </div>
      <TransactionsTable entries={entries} />
    </div>
  );
}
