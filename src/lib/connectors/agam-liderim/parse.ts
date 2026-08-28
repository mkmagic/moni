/**
 * Parser for the Agam Liderim (אגם לידרים) long-term-savings portfolio export.
 *
 * The agency's platform exports one Excel workbook consolidating every
 * long-term-savings account it holds for the member. This reads the first
 * sheet, `מוצרים ויתרות` (Products & Balances): one row per account, with the
 * current accumulated balance (`צבירה כוללת`) as the figure that matters.
 *
 * What the file does NOT carry — and this parser therefore never invents — is
 * any fee, movement, deposit or contribution detail. It is a balance snapshot
 * of many accounts, closer to what SnapTrade returns than to a provider's
 * statement, so it feeds the multi-account promotion path rather than the
 * single-statement one.
 *
 * The columns are fixed but the number of account rows is not: a member with
 * more accounts simply has more rows. So the header row is found by its labels,
 * columns are addressed by label, and data rows are read until they run out —
 * never by a hardcoded count. Zod is the trust boundary: a row missing a figure
 * it must have is rejected, never defaulted to a fabricated zero.
 *
 * Only the import worker imports this (via `./index`), keeping it — and its
 * xlsx reader — out of the Next server bundle (connector-interface.md §3).
 */
import Decimal from "decimal.js";
import { z } from "zod";
import type { LongTermSavingsProduct } from "../types";
import { DocumentParseError } from "../documents/types";
import { type Cell, type Grid, loadSheetByName, readZipEntries, splitRef } from "./xlsx";

export const AGAM_LIDERIM_PARSER_ID = "agam_liderim_portfolio";
/** Bump whenever extraction output changes for the same input (stored per row). */
export const AGAM_LIDERIM_PARSER_VERSION = 1;

/** The balances sheet. The workbook's second sheet is returns/exposures, unused here. */
const BALANCES_SHEET = "מוצרים ויתרות";

/** Column header labels on the balances sheet, exactly as printed. */
const HEADERS = {
  productType: "סוג מוצר",
  provider: "שם יצרן",
  infoDate: "נכונות מידע",
  policyNumber: "מספר פוליסה/ חשבון",
  productName: "שם מוצר",
  status: "סטטוס",
  joinDate: "תאריך הצטרפות",
  balance: "צבירה כוללת",
} as const;

/** A dash is the file's "not applicable / none" marker in any cell. */
const DASH = "-";

function isBlank(cell: Cell | undefined): boolean {
  return cell === undefined || cell.value.trim() === "" || cell.value.trim() === DASH;
}

/**
 * Excel serial date (1900 system) → ISO `yyyy-mm-dd`. The epoch is 1899-12-30
 * to absorb Excel's fictional 1900 leap day. Returns null for anything not a
 * finite number.
 */
function serialToIso(serial: string): string | null {
  const n = Number(serial);
  if (!Number.isFinite(n)) return null;
  const ms = Date.UTC(1899, 11, 30) + Math.round(n) * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Maps the Hebrew product-type column to Moni's product enum. Ordered so a
 * more specific term wins over the generic one it contains — `גמל להשקעה`
 * before `גמל`, and `השתלמות` (which the fund names also contain the word
 * `גמל` in) before `גמל`.
 *
 * A balance-bearing row whose type matches nothing known falls back to a
 * locked `gemel`: the balance still counts toward net worth (correctness) and
 * the presentation is the conservative one (locked), for the user to relabel.
 * The real Israeli product space is small and covered below, so this is a
 * rare edge, not the common path.
 */
function mapProduct(productType: string): LongTermSavingsProduct {
  const t = productType.replace(/["'׳״]/g, "").trim();
  if (t.includes("השתלמות")) return "hishtalmut";
  if (t.includes("גמל") && t.includes("השקעה")) return "gemel_investment";
  if (t.includes("מנהלים")) return "managers_insurance";
  if (t.includes("פנסיה")) return "pension";
  if (t.includes("גמל")) return "gemel";
  return "gemel";
}

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "not an ISO date")
  // A regex is a shape check, not a calendar check: reject 2026-13-40 here.
  .refine((value) => {
    const [y, m, d] = value.split("-").map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  }, "not a real calendar date");

const accountSchema = z.object({
  /** The policy/account number — the stable key an account is matched on. */
  policyNumber: z.string().min(1),
  /** The actual provider holding the money (Harel, Menora …) — the institution. */
  provider: z.string().min(1),
  /** Raw Hebrew product-type, kept for naming and display. */
  productType: z.string().min(1),
  productName: z.string().min(1).nullable(),
  product: z.enum(["pension", "hishtalmut", "gemel", "gemel_investment", "managers_insurance"]),
  status: z.string().min(1).nullable(),
  /** Exact-decimal balance string; never a float. */
  balance: z.string().regex(/^-?\d+(\.\d+)?$/, "not a decimal"),
  /** The balance's data-validity date (`נכונות מידע`) — its as-of. */
  asOf: isoDate,
  joinDate: isoDate.nullable(),
});

export type AgamLiderimAccount = z.infer<typeof accountSchema>;

export interface AgamLiderimPortfolio {
  /** `הופק בתאריך` — when the file was generated. Informational. */
  producedDate: string | null;
  accounts: AgamLiderimAccount[];
}

/** A cheap structural check that this workbook is the export this parser reads. */
export function recognises(buf: Buffer): boolean {
  let entries: Map<string, Buffer>;
  try {
    entries = readZipEntries(buf);
  } catch {
    return false;
  }
  const grid = loadSheetByName(entries, BALANCES_SHEET);
  if (!grid) return false;
  return findHeaderRow(grid) !== null;
}

/** The row and product-type column of the header, or null if absent. */
function findHeaderRow(grid: Grid): { row: number; productTypeCol: string } | null {
  for (const [ref, cell] of grid) {
    if (cell.isText && cell.value.trim() === HEADERS.productType) {
      const { col, row } = splitRef(ref);
      return { row, productTypeCol: col };
    }
  }
  return null;
}

/**
 * Parses the workbook bytes into a portfolio. Throws {@link DocumentParseError}
 * on anything it cannot read as this export.
 */
export function parseAgamLiderimPortfolio(bytes: Uint8Array): AgamLiderimPortfolio {
  const buf = Buffer.from(bytes);
  let entries: Map<string, Buffer>;
  try {
    entries = readZipEntries(buf);
  } catch {
    throw new DocumentParseError("unreadable_document");
  }

  const grid = loadSheetByName(entries, BALANCES_SHEET);
  if (!grid) throw new DocumentParseError("unrecognised_document");

  const header = findHeaderRow(grid);
  if (!header) throw new DocumentParseError("unrecognised_document");

  // Map each known header label to its column, on the header row. A file that
  // dropped or renamed a column we depend on is not one we can read.
  const colOf = new Map<keyof typeof HEADERS, string>();
  for (const [ref, cell] of grid) {
    if (!cell.isText) continue;
    const { row, col } = splitRef(ref);
    if (row !== header.row) continue;
    const label = cell.value.trim();
    for (const key of Object.keys(HEADERS) as (keyof typeof HEADERS)[]) {
      if (HEADERS[key] === label) colOf.set(key, col);
    }
  }
  for (const key of Object.keys(HEADERS) as (keyof typeof HEADERS)[]) {
    if (!colOf.has(key)) throw new DocumentParseError("malformed_document");
  }

  const producedDate = findProducedDate(grid);

  const cellAt = (key: keyof typeof HEADERS, row: number): Cell | undefined =>
    grid.get(`${colOf.get(key)}${row}`);
  const textAt = (key: keyof typeof HEADERS, row: number): string | null => {
    const cell = cellAt(key, row);
    return isBlank(cell) ? null : cell!.value.trim();
  };

  let maxRow = header.row;
  for (const ref of grid.keys()) maxRow = Math.max(maxRow, splitRef(ref).row);

  const accounts: AgamLiderimAccount[] = [];
  // A data row is any row below the header carrying a product type. The totals
  // row has none, so it is excluded, and the row count is whatever the file
  // holds. Rows with no accumulation (a pure risk/insurance policy, whose
  // balance prints as "-") are not savings accounts and are skipped.
  for (let row = header.row + 1; row <= maxRow; row++) {
    const productType = textAt("productType", row);
    if (!productType) continue;
    const balanceCell = cellAt("balance", row);
    if (isBlank(balanceCell)) continue;

    const joinRaw = cellAt("joinDate", row);
    const asOfRaw = cellAt("infoDate", row);
    const asOf = isBlank(asOfRaw) ? producedDate : serialToIso(asOfRaw!.value);

    const parsed = accountSchema.safeParse({
      policyNumber: textAt("policyNumber", row),
      provider: textAt("provider", row),
      productType,
      productName: textAt("productName", row),
      product: mapProduct(productType),
      status: textAt("status", row),
      balance: normaliseAmount(balanceCell!.value),
      asOf,
      joinDate: isBlank(joinRaw) ? null : serialToIso(joinRaw!.value),
    });
    // A recognised sheet with a row we cannot read cleanly is a malformed
    // document — never a silently dropped account.
    if (!parsed.success) throw new DocumentParseError("malformed_document");
    accounts.push(parsed.data);
  }

  return { producedDate, accounts };
}

/** `הופק בתאריך: dd/mm/yyyy` banner → ISO, or null when absent. */
function findProducedDate(grid: Grid): string | null {
  for (const [, cell] of grid) {
    const m = /הופק בתאריך:\s*(\d{2})\/(\d{2})\/(\d{4})/.exec(cell.value);
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  }
  return null;
}

/**
 * A money cell to an exact-decimal string, or the raw text if it is not a
 * number (Zod then rejects it). Excel serialises some figures with float
 * artifacts (`89788.90625`); `Decimal` canonicalises without widening in JS.
 */
function normaliseAmount(raw: string): string {
  const trimmed = raw.trim().replace(/,/g, "");
  try {
    return new Decimal(trimmed).toFixed();
  } catch {
    return trimmed;
  }
}
