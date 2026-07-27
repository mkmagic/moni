// src/domain/flows.ts — the single definition of "counts as income or an
// expense". Pinned here on its own so a new aggregate that gets it wrong
// fails a test rather than silently reporting different totals than the
// dashboard.
import { describe, expect, it } from "vitest";
import { countsAsFlow } from "@/domain/flows";

const TRANSFERS = new Set(["cat-transfer"]);

describe("countsAsFlow", () => {
  it("counts an ordinary categorized entry", () => {
    expect(countsAsFlow({ excluded: false, categoryId: "cat-groceries" }, TRANSFERS)).toBe(true);
  });

  it("counts an uncategorized entry — spending is still spending before it is labeled", () => {
    expect(countsAsFlow({ excluded: false, categoryId: null }, TRANSFERS)).toBe(true);
  });

  it("drops a transfer-classified entry, which is what stops card purchases counting twice", () => {
    expect(countsAsFlow({ excluded: false, categoryId: "cat-transfer" }, TRANSFERS)).toBe(false);
  });

  it("drops an excluded entry regardless of category", () => {
    expect(countsAsFlow({ excluded: true, categoryId: "cat-groceries" }, TRANSFERS)).toBe(false);
  });
});
