import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("dashboard net-worth sparkline", () => {
  it("uses the stock-history DTO and leaves the lower flow stat on monthly flows", async () => {
    const page = await readFile("src/app/(app)/dashboard/page.tsx", "utf8");
    expect(page).toContain("overview.netWorthHistory.map((point) => Number(point.amount))");
    expect(page).toContain("labels={netWorthLabels}");
    expect(page).toContain("series={overview.months.map((m) => m.net)}");
  });
});
