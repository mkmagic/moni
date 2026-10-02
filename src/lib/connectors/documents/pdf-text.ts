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

export function findLabel(items: Item[], pattern: RegExp): Item | undefined {
  return items.find((item) => pattern.test(item.text));
}

/** The value cell of the RTL label/value pair whose label matches `pattern`. */
export function valueAt(items: Item[], pattern: RegExp): string | null {
  const label = findLabel(items, pattern);
  return label ? numberLeftOf(items, label) : null;
}

/** One column of a table, anchored by the horizontal midpoint cells match to. */
export interface Column {
  title: string;
  centre: number;
}

/**
 * Derives a table's columns from its stacked header fragments: merges fragments
 * that overlap in x, so "תגמולי" over "עובד/ת" becomes one column whose centre
 * anchors the cells beneath it. `headerAnchor` is a cell on the header's own
 * baseline; the band it defines reaches ~14pt above to catch a stacked fragment.
 * Derived per page — no coordinate is hardcoded, so a table that omits a column
 * still parses.
 */
export function depositColumns(items: Item[], headerAnchor: Item): Column[] {
  const band = items.filter(
    (item) =>
      item.page === headerAnchor.page &&
      item.y <= headerAnchor.y + SAME_ROW &&
      item.y >= headerAnchor.y - 14,
  );

  const groups: Item[][] = [];
  for (const item of [...band].sort((a, b) => b.x - a.x)) {
    const overlapping = groups.find((group) =>
      group.some((other) => item.x < other.right && other.x < item.right),
    );
    if (overlapping) overlapping.push(item);
    else groups.push([item]);
  }

  return groups
    .map((group) => {
      const left = Math.min(...group.map((item) => item.x));
      const right = Math.max(...group.map((item) => item.right));
      return {
        title: [...group]
          .sort((a, b) => b.y - a.y)
          .map((item) => item.text)
          .join(" "),
        centre: (left + right) / 2,
      };
    })
    .sort((a, b) => b.centre - a.centre);
}

/** Widest gap, in points, between two pieces of one phrase on a baseline. */
const MAX_WORD_GAP = 6;

/** A gap wider than this between two merged pieces is a space. */
const SPACE_GAP = 1.2;

/**
 * Re-joins text a PDF emitted in pieces into the phrases the label patterns
 * match. Harel emits a whole phrase per run; Migdal emits one run per word and
 * Analyst one per Hebrew GLYPH, so on those a label like "דמי ניהול מחיסכון"
 * does not exist as an item until it is rebuilt here.
 *
 * Only text merges. A run carrying a digit always stands alone, because the
 * label/value rules above depend on a figure being its own item — and a figure
 * printed beside a label (a date in "יתרת הכספים בקרן ב- 30/06/2026") must not
 * be swallowed into it. Two phrases on one baseline sit further apart than
 * `MAX_WORD_GAP` on every report seen so far (the closest pair is ~16pt).
 */
export function mergeRuns(items: Item[]): Item[] {
  const rows = new Map<string, Item[]>();
  for (const item of items) {
    const key = [...rows.keys()].find((k) => {
      const [page, y] = k.split(":").map(Number);
      return page === item.page && Math.abs(y - item.y) <= 1;
    });
    const row = key ? rows.get(key) : undefined;
    if (row) row.push(item);
    else rows.set(`${item.page}:${item.y}`, [item]);
  }

  const merged: Item[] = [];
  for (const row of rows.values()) {
    let current: Item | undefined;
    for (const item of [...row].sort((a, b) => b.x - a.x)) {
      const textual = !/\d/.test(item.text);
      if (
        current &&
        textual &&
        !/\d/.test(current.text) &&
        current.x - item.right <= MAX_WORD_GAP
      ) {
        const gap = current.x - item.right;
        current.text = `${current.text}${gap > SPACE_GAP ? " " : ""}${item.text}`;
        current.x = Math.min(current.x, item.x);
        current.centre = (current.x + current.right) / 2;
      } else {
        current = { ...item };
        merged.push(current);
      }
    }
  }
  return merged;
}

/**
 * The percentage to the left of the label matching `pattern`, without its
 * "%". Providers print it either as one run ("0.63%") or as a number with a
 * separate "%" glyph beside it; both read the same here.
 */
export function percentAt(items: Item[], pattern: RegExp): string | null {
  const label = findLabel(items, pattern);
  if (!label) return null;
  let best: Item | undefined;
  for (const item of items) {
    if (item === label || !sameRow(item, label) || item.right > label.x) continue;
    if (label.x - item.right > MAX_LABEL_GAP) continue;
    if (!/^\d+(\.\d+)?%$/.test(item.text) && !(isNumber(item) && hasPercentSign(items, item)))
      continue;
    if (!best || item.right > best.right) best = item;
  }
  return best ? best.text.replace("%", "") : null;
}
