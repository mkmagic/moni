import type { ReactNode } from "react";
import { BudgetTabs } from "./budget-tabs";

export default function BudgetLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Budget</h1>
        <p className="text-sm text-muted-foreground">
          {"What you meant to spend, against what you did."}
        </p>
      </div>
      <BudgetTabs />
      {children}
    </div>
  );
}
