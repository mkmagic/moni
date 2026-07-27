import type { ReactNode } from "react";
import { TransactionsTabs } from "./transactions-tabs";

export default function TransactionsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Transactions</h1>
        <p className="text-sm text-muted-foreground">
          Your latest income and expenses, and the rules that categorize them
        </p>
      </div>
      <TransactionsTabs />
      {children}
    </div>
  );
}
