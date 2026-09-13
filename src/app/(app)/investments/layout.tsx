import type { ReactNode } from "react";
import { InvestmentsTabs } from "./investments-tabs";

/** Shared frame for the three investments destinations (Overview / Performance /
 * Activity & lots): one page title and one sub-navigation, identical across all
 * three, with each route rendering its own content below. */
export default function InvestmentsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold text-foreground">Investments</h1>
        <InvestmentsTabs />
      </div>
      {children}
    </div>
  );
}
