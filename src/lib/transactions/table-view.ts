// The client-side half of the transactions table (issue #14).
//
// `description_ct` and `entered_amount_ct` are encrypted at rest, so Postgres
// cannot search a payee or order by an amount — those columns only exist once
// `listEntries` has decrypted them. Date and category filtering stay in SQL
// (see `EntryFilters`); everything here runs in the browser over the window
// the server already returned, which is why the table states how far that
// window reaches.
//
// Two deliberate asymmetries, both about what the control is *asking*:
//   - the amount **range** is on the magnitude. Almost every ledger row is
//     negative, so a signed range would make "min 100" hide all spending.
//   - the amount **sort** is signed, ordering the figures as displayed, so
//     ascending puts the largest expense first.
import Decimal from "decimal.js";
import type { EntryView } from "@/domain/transactions";
import {
  matchesDirection,
  matchesSize,
  type Direction,
  type SizeKey,
} from "@/lib/transactions/predicates";

/** The Income/Payment and expense-size selections. They live in the URL (not
 * in `TableControls`), so the same values can drive the client filter here and
 * a complete server-side filter (`listEntries`) when searching the whole
 * history. */
export interface ViewFilters {
  direction: Direction;
  size: SizeKey;
}

export const DEFAULT_VIEW_FILTERS: ViewFilters = { direction: "all", size: "all" };

export type SortColumn = "date" | "account" | "category" | "payee" | "amount";
export type SortDirection = "asc" | "desc";

export interface TableSort {
  column: SortColumn;
  direction: SortDirection;
}

export interface TableControls {
  /** Free text over the payee. Trimmed and case-folded before matching. */
  query: string;
  /** Inclusive magnitude bounds as decimal strings; "" means unset. */
  minAmount: string;
  maxAmount: string;
  sort: TableSort;
}

export const DEFAULT_TABLE_CONTROLS: TableControls = {
  query: "",
  minAmount: "",
  maxAmount: "",
  // Newest first, matching `listEntries`' own ORDER BY, so the first paint
  // agrees with the server and re-sorting is always a deliberate act.
  sort: { column: "date", direction: "desc" },
};

/** The payee text the row renders. Search and sort both read through this so
 * they can never match or order by something the user cannot see. */
export function payeeOf(entry: EntryView): string {
  return entry.merchantName ?? entry.description;
}

/** `null` for a blank or unparseable bound — a half-typed "-" or "1." must
 * leave the table alone rather than emptying it. */
function parseBound(raw: string): Decimal | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  try {
    const d = new Decimal(trimmed);
    return d.isFinite() ? d.abs() : null;
  } catch {
    return null;
  }
}

// Locale pinned, per the hydration lesson in the ui-developer skill: an
// implicit-locale call can order differently on the server than in the
// browser. "en" still orders Hebrew payees consistently.
const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

function compareText(a: string, b: string): number {
  return collator.compare(a, b);
}

function flip(direction: SortDirection): number {
  return direction === "asc" ? 1 : -1;
}

/**
 * The absence of a category is not a value that sorts before or after the real
 * ones, so it is ranked *outside* the direction flip and always lands last.
 * Returns `null` when neither row is uncategorized and the normal comparison
 * should run.
 */
function rankUncategorizedLast(a: EntryView, b: EntryView): number | null {
  if (a.categoryName !== null && b.categoryName !== null) return null;
  if (a.categoryName === b.categoryName) return 0;
  return a.categoryName === null ? 1 : -1;
}

function compareBy(a: EntryView, b: EntryView, column: SortColumn): number {
  switch (column) {
    case "date":
      // ISO-8601 dates order correctly as plain strings.
      return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    case "account":
      return compareText(a.accountName, b.accountName);
    case "category":
      return compareText(a.categoryName ?? "", b.categoryName ?? "");
    case "payee":
      return compareText(payeeOf(a), payeeOf(b));
    case "amount":
      return new Decimal(a.amount.amount).comparedTo(new Decimal(b.amount.amount));
  }
}

/**
 * Applies the client-side controls to the window of entries the server
 * returned. Never mutates `entries`; the sort is stable, so rows tied on the
 * chosen column keep the order the domain layer gave them.
 */
export function applyTableControls(
  entries: EntryView[],
  controls: TableControls,
  view: ViewFilters = DEFAULT_VIEW_FILTERS,
): EntryView[] {
  const q = controls.query.trim().toLowerCase();
  const min = parseBound(controls.minAmount);
  const max = parseBound(controls.maxAmount);

  const filtered = entries.filter((entry) => {
    // Income/Payment and expense-size share their definition with the server's
    // whole-history search (`src/lib/transactions/predicates.ts`).
    if (!matchesDirection(entry, view.direction)) return false;
    if (!matchesSize(entry, view.size)) return false;
    if (q !== "" && !payeeOf(entry).toLowerCase().includes(q)) return false;
    if (min || max) {
      const magnitude = new Decimal(entry.amount.amount).abs();
      if (min && magnitude.lessThan(min)) return false;
      if (max && magnitude.greaterThan(max)) return false;
    }
    return true;
  });

  return filtered.sort((a, b) => {
    if (controls.sort.column === "category") {
      const uncategorized = rankUncategorizedLast(a, b);
      if (uncategorized !== null) return uncategorized;
    }
    return compareBy(a, b, controls.sort.column) * flip(controls.sort.direction);
  });
}
