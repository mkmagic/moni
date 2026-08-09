import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("dashboard net-worth sparkline", () => {
  it("feeds the hero sparkline the stock history and the monthly flows to the This month card", async () => {
    const page = await readFile("src/app/(app)/dashboard/page.tsx", "utf8");
    // The one net-worth hero still charts the net-worth history (a stock).
    expect(page).toContain("overview.netWorthHistory.map((point) => Number(point.amount))");
    expect(page).toContain("labels={netWorthLabels}");
    // The monthly-flow series now feeds the "This month" card's Income-vs-
    // Expenses sparkline — not a second "Net Worth" card that plotted flow
    // under a stock's label (the duplicate the redesign removed).
    expect(page).toContain("months={overview.months}");
  });
});
