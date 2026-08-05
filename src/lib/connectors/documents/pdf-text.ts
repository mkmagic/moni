/**
 * Layout-agnostic geometry for reading right-to-left PDFs.
 *
 * Everything here is a fact about how an RTL statement is laid out, not about
 * any one provider: the value cell of a label/value pair sits to the LEFT of
 * its Hebrew label, a "%" glyph abuts the number it qualifies, and cells that
 * share a baseline belong to the same row. Provider-specific table reading
 * (column derivation, section anchors) stays with that provider's parser.
 *
 * Deliberately free of `pdfjs` — loading a document lives in `pdf-load.ts`, so
 * importing these helpers never drags the PDF library into a bundle. See
 * docs/design/connector-interface.md §3.
 */

/** One positioned run of text, in PDF user space (origin bottom-left). */
export interface Item {
  text: string;
  /** Left edge. */
  x: number;
  /** Right edge. */
  right: number;
  /** Baseline. */
  y: number;
  /** Horizontal midpoint — what cells are matched to table columns by. */
  centre: number;
  /** 1-based page number. */
  page: number;
}

/**
 * Same-baseline tolerance, in points. Harel stacks header fragments about 11pt
 * apart and body rows about 14pt apart, so 2.5 separates rows without splitting
 * one whose glyphs sit a hair off the baseline.
 */
export const SAME_ROW = 2.5;

/** A value cell never sits further than this from the label it belongs to. */
const MAX_LABEL_GAP = 140;

/** Digits with optional thousands separators and an optional sign/fraction. */
const NUMBER = /^-?\d{1,3}(,\d{3})*(\.\d+)?$|^-?\d+(\.\d+)?$/;

export function sameRow(a: Item, b: Item): boolean {
  return a.page === b.page && Math.abs(a.y - b.y) <= SAME_ROW;
}

export function isNumber(item: Item): boolean {
  return NUMBER.test(item.text);
}

/** Strips thousands separators, leaving a string `Decimal` accepts. */
export function toDecimalString(text: string): string {
  return text.replace(/,/g, "");
}

/**
 * The number immediately to the left of `label` on the same baseline — the
 * value cell of an RTL label/value pair. Null when the cell is blank or holds a
 * dash (Harel prints "-" for "not applicable").
 */
export function numberLeftOf(items: Item[], label: Item): string | null {
  let best: Item | undefined;
  for (const item of items) {
    if (item === label || !sameRow(item, label) || item.right > label.x) continue;
    if (label.x - item.right > MAX_LABEL_GAP) continue;
    if (!isNumber(item)) continue;
    if (!best || item.right > best.right) best = item;
  }
  return best ? toDecimalString(best.text) : null;
}

/** True when a "%" glyph abuts the right edge of `value`. */
export function hasPercentSign(items: Item[], value: Item): boolean {
  return items.some(
    (item) => item.text === "%" && sameRow(item, value) && Math.abs(item.x - value.right) < 6,
  );
}

/**
 * Groups items into rows by baseline, ordered top-to-bottom. Items must already
 * be filtered to a single page — baselines repeat across pages.
 */
export function groupRows(items: Item[]): Item[][] {
  const byRow = new Map<number, Item[]>();
  for (const item of items) {
    const key = [...byRow.keys()].find((k) => Math.abs(k - item.y) <= SAME_ROW) ?? item.y;
    const row = byRow.get(key);
    if (row) row.push(item);
    else byRow.set(key, [item]);
  }
  return [...byRow.entries()].sort((a, b) => b[0] - a[0]).map(([, row]) => row);
}

/** Joins items into reading order for RTL text: rightmost first. */
export function joinRtl(items: Item[]): string {
  return [...items]
    .sort((a, b) => b.x - a.x)
    .map((item) => item.text)
    .join(" ");
}
