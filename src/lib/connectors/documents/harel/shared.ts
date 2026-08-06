/**
 * What Harel's two report parsers share. Both the quarterly pension report and
 * the קרן השתלמות report (quarterly and annual) letter their sections א–ה the
 * same way, print dd/mm/yyyy dates, and lay out section ה's deposits table the
 * same way, so these anchors, the date normalisers and the multi-page table
 * plumbing are identical between them.
 *
 * The Zod primitives and the date normalisers are generic-Israeli rather than
 * strictly Harel — a non-Harel Israeli provider would want them too. They live
 * here until a second provider proves that shape, the same "wait for the second
 * example" discipline the parsers themselves keep. The pure RTL geometry
 * (`valueAt`, `depositColumns`, `Column`) is already provider-agnostic and lives
 * in `../pdf-text`.
 */
import { z } from "zod";
import { valueAt, type Item } from "../pdf-text";
import { DocumentParseError } from "../types";

// ------------------------------------------------------------------- shape

export const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/);
export const isoDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const isoMonthString = z.string().regex(/^\d{4}-\d{2}$/);

// ------------------------------------------------------------------ anchors

export const DATE = String.raw`\d{2}\/\d{2}\/\d{4}`;
export const DEPOSITS_SECTION = /^ה\. פירוט הפקדות/;
export const DEPOSITS_HEADER_ANCHOR = "מועד";
export const TOTALS_CELL = /^סה"כ$/;

/**
 * `dd/mm/yyyy` → `yyyy-mm-dd`, rejecting a date the calendar does not have.
 * A Zod `regex` on the result only checks the shape, so without this a misread
 * "31/13/2026" would travel all the way to a Postgres `date` column and surface
 * as a promotion failure rather than as the parse failure it is.
 */
export function isoDate(ddmmyyyy: string): string {
  const [d, m, y] = ddmmyyyy.split("/");
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (
    date.getUTCFullYear() !== Number(y) ||
    date.getUTCMonth() !== Number(m) - 1 ||
    date.getUTCDate() !== Number(d)
  )
    throw new DocumentParseError("malformed_document");
  return `${y}-${m}-${d}`;
}

export function isoMonth(mmyyyy: string): string {
  const [m, y] = mmyyyy.split("/");
  if (Number(m) < 1 || Number(m) > 12) throw new DocumentParseError("malformed_document");
  return `${y}-${m}`;
}

/** A section-ב figure the document must carry; its absence means a misparse. */
export function requiredValueAt(items: Item[], pattern: RegExp): string {
  const value = valueAt(items, pattern);
  if (value === null) throw new DocumentParseError("malformed_document");
  return value;
}

// ------------------------------------------------------- section ה (table)

/**
 * Section ה, which continues across pages: Harel repeats the section heading and
 * the column header on each page it spills onto, and prints the totals row only
 * on the last. Columns are re-derived per page by `parsePage` rather than carried
 * over, because each page's header is the authority for its own cells.
 *
 * A page carrying the section heading without a column header means the layout
 * moved. Skipping it would drop that page's deposits silently, and the only
 * check that could notice needs the totals row — printed on the last page alone.
 */
export function parseDeposits<Row, Totals>(
  items: Item[],
  parsePage: (items: Item[], anchor: Item) => { rows: Row[]; totals: Totals | null },
): { rows: Row[]; totals: Totals | null } {
  const rows: Row[] = [];
  let totals: Totals | null = null;

  for (const heading of items.filter((item) => DEPOSITS_SECTION.test(item.text))) {
    const anchor = items.find(
      (item) =>
        item.page === heading.page &&
        item.text === DEPOSITS_HEADER_ANCHOR &&
        item.y < heading.y &&
        heading.y - item.y < 30,
    );
    if (!anchor) throw new DocumentParseError("malformed_document");
    const page = parsePage(items, anchor);
    rows.push(...page.rows);
    if (page.totals) totals = page.totals;
  }

  return { rows, totals };
}
