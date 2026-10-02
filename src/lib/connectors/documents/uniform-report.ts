/**
 * What the Migdal and Analyst parsers share. Both reports follow the regulator's
 * uniform member-report layout (sections א–ו, the same section-ד footnote), but
 * neither emits a phrase per text run the way Harel does — Migdal emits words,
 * Analyst single glyphs — so both read the page through `mergeRuns` first, and
 * both need the page as text lines rather than as runs.
 *
 * Free of `pdfjs` — see pdf-text.ts.
 */
import {
  SAME_ROW,
  findLabel,
  groupRows,
  hasPercentSign,
  isNumber,
  joinRtl,
  toDecimalString,
  type Item,
} from "./pdf-text";

/** Page 1 as text lines, top to bottom, each read right to left. */
export function pageText(items: Item[]): string {
  return groupRows(items.filter((item) => item.page === 1))
    .map(joinRtl)
    .join("\n");
}

export interface ReturnTrack {
  name: string;
  returnPercent: string;
}

/**
 * Section ד — investment tracks and their returns, which on these reports is
 * one figure per track (no expected-cost column).
 *
 * The section shares its baselines with section ב beside it, so rows are
 * bounded on the right by the section's own footnote ("*תשואות שהושגו…"),
 * which spans the section's full width. A track name that wraps ("מסלול לבני 50
 * ומטה -" / "תלוי גיל") continues on a row with no figure, and is joined back.
 */
export function parseReturnTracks(items: Item[]): ReturnTrack[] {
  const heading = findLabel(items, /^ד\. מסלולי השקעה/);
  const footnote = items.find(
    (item) => heading && item.y < heading.y && /^\*?\s*תשואות שהושגו/.test(item.text),
  );
  if (!heading || !footnote) return [];

  const body = items.filter(
    (item) =>
      item.page === heading.page &&
      item.y < heading.y - SAME_ROW &&
      item.y > footnote.y + SAME_ROW &&
      item.right <= footnote.right + 3,
  );

  const tracks: ReturnTrack[] = [];
  for (const row of groupRows(body)) {
    const figure = row.find(
      (item) => /^-?\d+(\.\d+)?%$/.test(item.text) || (isNumber(item) && hasPercentSign(row, item)),
    );
    const name = joinRtl(row.filter((item) => item !== figure && item.text !== "%"));
    if (figure && name)
      tracks.push({ name, returnPercent: toDecimalString(figure.text.replace("%", "")) });
    // A row with no figure continues the previous track's name; before the
    // first track it is the heading's own second line.
    else if (!figure && name && tracks.length > 0) tracks[tracks.length - 1].name += ` ${name}`;
  }
  return tracks;
}
