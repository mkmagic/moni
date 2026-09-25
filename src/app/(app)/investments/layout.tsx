import type { ReactNode } from "react";
import { requireSession } from "@/domain/auth";
import { readInvestmentActivity } from "@/domain/investment-activity-resolution";
import { InvestmentsTabs } from "./investments-tabs";

/** Shared frame for the three investments destinations (Overview / Performance /
 * Activity & lots): one page title and one sub-navigation, identical across all
 * three, with each route rendering its own content below. */
export default async function InvestmentsLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  const { pendingCount } = await readInvestmentActivity(session);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold text-foreground">Investments</h1>
        <InvestmentsTabs pendingCount={pendingCount} />
      </div>
      {children}
    </div>
  );
}
