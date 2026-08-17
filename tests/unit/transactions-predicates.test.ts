// Shared Income/Payment and expense-size predicates (issue #107). These run
// over decrypted rows in two places (the client table and the server's
// whole-history search), so their meaning is pinned here once.
import { describe, expect, it } from "vitest";
import { matchesDirection, matchesSize } from "@/lib/transactions/predicates";
import type { EntryView } from "@/domain/transactions";

function entry(over: Partial<EntryView> & Pick<EntryView, "id">): EntryView {
  return {
    date: "2026-07-01",
    dateLabel: "1 Jul 2026",
    description: "Some purchase",
    matchText: "some purchase",
    accountId: "acct-1",
    accountName: "Checking",
    categoryId: "cat-1",
    categoryName: "Groceries",
    categoryLocked: false,
    isTransfer: false,
    merchantName: null,
    installmentLabel: null,
    amount: { amount: "-100", currency: "ILS" },
    fxPending: false,
    excluded: false,
    status: "posted",
    ...over,
  };
}

describe("matchesSize", () => {
  const size = (amount: string, key: Parameters<typeof matchesSize>[1]) =>
    matchesSize(entry({ id: "x", amount: { amount, currency: "ILS" } }), key);

  it('"all" keeps everything', () => {
    expect(size("-9999", "all")).toBe(true);
    expect(size("0", "all")).toBe(true);
  });

  it("puts the boundaries 100 and 1000 in the Medium band", () => {
    // Bands are disjoint and gapless: S = [0,100), M = [100,1000], L = (1000,∞).
    expect(size("-99.99", "s")).toBe(true);
    expect(size("-100", "s")).toBe(false);
    expect(size("-100", "m")).toBe(true);
    expect(size("-1000", "m")).toBe(true);
    expect(size("-1000.01", "m")).toBe(false);
    expect(size("-1000.01", "l")).toBe(true);
    expect(size("-1000", "l")).toBe(false);
  });

  it("ignores sign — an inflow is sized by magnitude", () => {
    expect(size("500", "m")).toBe(true);
  });

  it("excludes pending-FX rows, whose amount is in another currency", () => {
    const usd = entry({
      id: "fx",
      amount: { amount: "-50", currency: "USD" },
      fxPending: true,
    });
    expect(matchesSize(usd, "s")).toBe(false);
    expect(matchesSize(usd, "all")).toBe(true);
  });
});

describe("matchesDirection", () => {
  it('"all" keeps everything', () => {
    expect(
      matchesDirection(entry({ id: "a", amount: { amount: "-100", currency: "ILS" } }), "all"),
    ).toBe(true);
  });

  it("income is a positive flow, payment a negative one", () => {
    const inflow = entry({ id: "in", amount: { amount: "800", currency: "ILS" } });
    const outflow = entry({ id: "out", amount: { amount: "-100", currency: "ILS" } });
    expect(matchesDirection(inflow, "income")).toBe(true);
    expect(matchesDirection(inflow, "payment")).toBe(false);
    expect(matchesDirection(outflow, "payment")).toBe(true);
    expect(matchesDirection(outflow, "income")).toBe(false);
  });

  it("a transfer is neither income nor payment, whatever its sign", () => {
    // The credit-card settlement case: a large negative that is money moved,
    // not spent (src/domain/flows.ts).
    const settlement = entry({
      id: "t",
      isTransfer: true,
      amount: { amount: "-3008.98", currency: "ILS" },
    });
    expect(matchesDirection(settlement, "payment")).toBe(false);
    expect(matchesDirection(settlement, "income")).toBe(false);
  });

  it("an excluded row is neither", () => {
    const excluded = entry({ id: "e", excluded: true, amount: { amount: "500", currency: "ILS" } });
    expect(matchesDirection(excluded, "income")).toBe(false);
    expect(matchesDirection(excluded, "payment")).toBe(false);
  });

  it("a zero-amount row matches neither income nor payment", () => {
    const zero = entry({ id: "z", amount: { amount: "0", currency: "ILS" } });
    expect(matchesDirection(zero, "income")).toBe(false);
    expect(matchesDirection(zero, "payment")).toBe(false);
  });
});
