// src/lib/transactions/table-view.ts — the client-side half of the
// transactions table (issue #14). Descriptions and amounts are encrypted at
// rest, so search, amount-range and column sort can only run after
// decryption, in JS, over the window the server already returned. This pins
// that behaviour so the table's ordering and matching can't drift.
import { describe, expect, it } from "vitest";
import { applyTableControls, DEFAULT_TABLE_CONTROLS } from "@/lib/transactions/table-view";
import type { TableControls } from "@/lib/transactions/table-view";
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
    dateLocked: false,
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

const controls = (over: Partial<TableControls> = {}): TableControls => ({
  ...DEFAULT_TABLE_CONTROLS,
  ...over,
});

const ids = (rows: EntryView[]) => rows.map((r) => r.id);

describe("applyTableControls — search", () => {
  const rows = [
    entry({ id: "a", description: "Rami Levy Tel Aviv" }),
    entry({ id: "b", description: "raw card charge", merchantName: "Shufersal" }),
    entry({ id: "c", description: "Electric bill" }),
  ];

  it("matches the payee text the row actually displays", () => {
    expect(ids(applyTableControls(rows, controls({ query: "shufersal" })))).toEqual(["b"]);
  });

  it("falls back to the description when there is no merchant name", () => {
    expect(ids(applyTableControls(rows, controls({ query: "rami" })))).toEqual(["a"]);
  });

  it("does not match a description that the row hides behind a merchant name", () => {
    // Row `b` renders "Shufersal", so matching its raw description would
    // return a row with no visible reason to be there.
    expect(ids(applyTableControls(rows, controls({ query: "raw card" })))).toEqual([]);
  });

  it("is case-insensitive and ignores surrounding whitespace", () => {
    expect(ids(applyTableControls(rows, controls({ query: "  ELECTRIC  " })))).toEqual(["c"]);
  });

  it("returns every row for an empty query", () => {
    expect(ids(applyTableControls(rows, controls({ query: "" })))).toHaveLength(3);
  });

  it("searches the payee only — an account or category name is not a match", () => {
    // The owner declined an account filter; search must not quietly reintroduce
    // one by matching columns the query box doesn't claim to cover.
    expect(ids(applyTableControls(rows, controls({ query: "checking" })))).toEqual([]);
    expect(ids(applyTableControls(rows, controls({ query: "groceries" })))).toEqual([]);
  });
});

describe("applyTableControls — amount range", () => {
  // The range is on the *magnitude*. Nearly every ledger row is negative, so a
  // signed range would make "min 100" hide all spending — a trap, not a filter.
  const rows = [
    entry({ id: "small", amount: { amount: "-40.50", currency: "ILS" } }),
    entry({ id: "mid", amount: { amount: "-250", currency: "ILS" } }),
    entry({ id: "big", amount: { amount: "-1200.99", currency: "ILS" } }),
    entry({ id: "income", amount: { amount: "800", currency: "ILS" } }),
  ];

  it("keeps rows at or above the minimum, ignoring sign", () => {
    expect(ids(applyTableControls(rows, controls({ minAmount: "250" })))).toEqual([
      "mid",
      "big",
      "income",
    ]);
  });

  it("keeps rows at or below the maximum, ignoring sign", () => {
    expect(ids(applyTableControls(rows, controls({ maxAmount: "250" })))).toEqual(["small", "mid"]);
  });

  it("applies both bounds together", () => {
    expect(ids(applyTableControls(rows, controls({ minAmount: "100", maxAmount: "900" })))).toEqual(
      ["mid", "income"],
    );
  });

  it("compares exact decimals, not floats", () => {
    // Both of these collapse to the same float64 (1e18), and so does the
    // bound — only exact decimals can tell them apart.
    const wide = [
      entry({ id: "under", amount: { amount: "-1000000000000000000.01", currency: "ILS" } }),
      entry({ id: "over", amount: { amount: "-1000000000000000000.03", currency: "ILS" } }),
    ];
    expect(
      ids(applyTableControls(wide, controls({ minAmount: "1000000000000000000.02" }))),
    ).toEqual(["over"]);
  });

  it("ignores a blank or unparseable bound rather than filtering everything out", () => {
    expect(ids(applyTableControls(rows, controls({ minAmount: "", maxAmount: "" })))).toHaveLength(
      4,
    );
    expect(ids(applyTableControls(rows, controls({ minAmount: "abc" })))).toHaveLength(4);
  });
});

describe("applyTableControls — Income/Payment and size", () => {
  // The predicates themselves are pinned in transactions-predicates.test.ts;
  // this only checks the third argument is honoured and composes with the rest.
  const rows = [
    entry({ id: "big-expense", amount: { amount: "-1200", currency: "ILS" } }),
    entry({ id: "small-expense", amount: { amount: "-40", currency: "ILS" } }),
    entry({ id: "salary", amount: { amount: "8000", currency: "ILS" } }),
    entry({ id: "transfer", isTransfer: true, amount: { amount: "-500", currency: "ILS" } }),
  ];

  it("defaults to keeping every row when no view filter is passed", () => {
    expect(ids(applyTableControls(rows, controls()))).toHaveLength(4);
  });

  it("filters to payments, dropping income and transfers", () => {
    expect(
      ids(applyTableControls(rows, controls(), { direction: "payment", size: "all" })),
    ).toEqual(["big-expense", "small-expense"]);
  });

  it("filters to income", () => {
    expect(ids(applyTableControls(rows, controls(), { direction: "income", size: "all" }))).toEqual(
      ["salary"],
    );
  });

  it("composes a size band with a direction", () => {
    // Large (>₪1,000) payments only: the ₪8,000 salary is Large too, but it is
    // income, so the direction drops it.
    expect(ids(applyTableControls(rows, controls(), { direction: "payment", size: "l" }))).toEqual([
      "big-expense",
    ]);
  });
});

describe("applyTableControls — sort", () => {
  const rows = [
    entry({ id: "a", date: "2026-07-03", accountName: "Visa", categoryName: "Rent" }),
    entry({ id: "b", date: "2026-07-01", accountName: "Checking", categoryName: "Groceries" }),
    entry({ id: "c", date: "2026-07-02", accountName: "Savings", categoryName: null }),
  ];

  it("defaults to newest first, matching the server's own order", () => {
    expect(DEFAULT_TABLE_CONTROLS.sort).toEqual({ column: "date", direction: "desc" });
    expect(ids(applyTableControls(rows, controls()))).toEqual(["a", "c", "b"]);
  });

  it("sorts by date ascending", () => {
    expect(
      ids(applyTableControls(rows, controls({ sort: { column: "date", direction: "asc" } }))),
    ).toEqual(["b", "c", "a"]);
  });

  it("sorts by account name", () => {
    expect(
      ids(applyTableControls(rows, controls({ sort: { column: "account", direction: "asc" } }))),
    ).toEqual(["b", "c", "a"]);
  });

  it("keeps uncategorized rows last in both directions", () => {
    // "—" is the absence of a value, not a value that sorts before or after
    // the others; parking it at the end keeps the real categories adjacent.
    expect(
      ids(applyTableControls(rows, controls({ sort: { column: "category", direction: "asc" } }))),
    ).toEqual(["b", "a", "c"]);
    expect(
      ids(applyTableControls(rows, controls({ sort: { column: "category", direction: "desc" } }))),
    ).toEqual(["a", "b", "c"]);
  });

  it("sorts the payee column by the text the row displays", () => {
    const payees = [
      entry({ id: "a", description: "Zebra", merchantName: null }),
      entry({ id: "b", description: "ignored", merchantName: "Aardvark" }),
    ];
    expect(
      ids(applyTableControls(payees, controls({ sort: { column: "payee", direction: "asc" } }))),
    ).toEqual(["b", "a"]);
  });

  it("sorts amounts by signed exact-decimal value, so the largest expense leads", () => {
    const amounts = [
      entry({ id: "income", amount: { amount: "800", currency: "ILS" } }),
      entry({ id: "big-expense", amount: { amount: "-1200.99", currency: "ILS" } }),
      entry({ id: "small-expense", amount: { amount: "-40.50", currency: "ILS" } }),
    ];
    expect(
      ids(applyTableControls(amounts, controls({ sort: { column: "amount", direction: "asc" } }))),
    ).toEqual(["big-expense", "small-expense", "income"]);
  });

  it("orders amounts numerically, not as strings", () => {
    const amounts = [
      entry({ id: "nine", amount: { amount: "9", currency: "ILS" } }),
      entry({ id: "eighty", amount: { amount: "80", currency: "ILS" } }),
    ];
    expect(
      ids(applyTableControls(amounts, controls({ sort: { column: "amount", direction: "asc" } }))),
    ).toEqual(["nine", "eighty"]);
  });

  it("is stable — rows tied on the sort column keep the order the server gave them", () => {
    const tied = [
      entry({ id: "x", date: "2026-07-01", accountName: "Same" }),
      entry({ id: "y", date: "2026-07-01", accountName: "Same" }),
    ];
    const asc = controls({ sort: { column: "account", direction: "asc" } });
    expect(ids(applyTableControls(tied, asc))).toEqual(["x", "y"]);
    expect(ids(applyTableControls([...tied].reverse(), asc))).toEqual(["y", "x"]);
  });

  it("does not mutate the array it was given", () => {
    const original = [...rows];
    applyTableControls(rows, controls({ sort: { column: "amount", direction: "asc" } }));
    expect(rows).toEqual(original);
  });
});
