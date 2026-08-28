/**
 * A minimal read-only .xlsx reader: enough to pull one worksheet out of the
 * Agam Liderim export as a `{ "A1": value }` cell grid. An .xlsx is a ZIP of
 * XML, so this is a small central-directory ZIP reader (Node `zlib` inflate)
 * plus `fast-xml-parser`, which the repo already depends on.
 *
 * Deliberately not a general spreadsheet library. The one file this reads uses
 * inline strings and stores Hebrew as numeric character references, and the
 * columns are fixed; a full library (styles, formulas, shared-string tables,
 * streaming) would be far more surface than the job needs. If a second xlsx
 * source ever lands, revisit — but not before.
 *
 * Free of `pdfjs`, and only ever imported by the import worker, so `next build`
 * never bundles it — the same containment the PDF path gets (connector-
 * interface.md §3).
 */
import { inflateRawSync } from "node:zlib";
import { XMLParser } from "fast-xml-parser";

/** A single cell's value, tagged with whether it came from a string cell. */
export interface Cell {
  value: string;
  isText: boolean;
}

/** A worksheet as a sparse map keyed by A1-style cell reference. */
export type Grid = Map<string, Cell>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  // Every value stays a string; money is never widened to a float here.
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
  htmlEntities: true,
});

/**
 * Reads the entries of a ZIP archive by walking its central directory, which
 * always carries the compressed size — robust to entries whose local header
 * omits it (a streamed write). Throws on anything that is not a ZIP.
 */
export function readZipEntries(buf: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  // End Of Central Directory record: signature 0x06054b50, scanned from the end
  // (it is followed only by an optional comment).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt central directory");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);

    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error("corrupt local header");
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    // Method 0 is stored, 8 is deflate; the export only ever uses these two.
    if (method !== 0 && method !== 8) throw new Error(`unsupported zip method ${method}`);
    entries.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));

    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Decodes any numeric/named XML entities left intact by the parser. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Loads one worksheet, addressed by its tab name (`מוצרים ויתרות`), into a cell
 * grid. Returns null when no sheet by that name exists — the caller decides
 * whether that means the wrong file.
 */
export function loadSheetByName(entries: Map<string, Buffer>, sheetName: string): Grid | null {
  const workbookBuf = entries.get("xl/workbook.xml");
  const relsBuf = entries.get("xl/_rels/workbook.xml.rels");
  if (!workbookBuf || !relsBuf) return null;

  const wb = parser.parse(workbookBuf.toString("utf8"));
  const sheet = asArray<Record<string, string>>(wb?.workbook?.sheets?.sheet).find(
    (s) => s["@name"] === sheetName,
  );
  if (!sheet) return null;

  const rels = parser.parse(relsBuf.toString("utf8"));
  const rel = asArray<Record<string, string>>(rels?.Relationships?.Relationship).find(
    (r) => r["@Id"] === sheet["@r:id"],
  );
  if (!rel) return null;
  const target = rel["@Target"].replace(/^\/+/, "");
  const path = target.startsWith("xl/") ? target : `xl/${target}`;
  const sheetBuf = entries.get(path);
  if (!sheetBuf) return null;

  const ws = parser.parse(sheetBuf.toString("utf8"));
  const grid: Grid = new Map();
  for (const row of asArray<Record<string, unknown>>(ws?.worksheet?.sheetData?.row)) {
    for (const c of asArray<Record<string, unknown>>(row.c as never)) {
      const ref = c["@r"];
      if (typeof ref !== "string") continue;
      if (c["@t"] === "inlineStr") {
        const t = (c.is as Record<string, unknown> | undefined)?.t;
        const value =
          t && typeof t === "object" ? ((t as Record<string, unknown>)["#text"] ?? "") : (t ?? "");
        grid.set(ref, { value: decodeEntities(String(value)), isText: true });
      } else if (c.v !== undefined && c.v !== null) {
        grid.set(ref, { value: decodeEntities(String(c.v)), isText: false });
      }
    }
  }
  return grid;
}

/** Splits an A1-style reference into its column letters and 1-based row. */
export function splitRef(ref: string): { col: string; row: number } {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) throw new Error(`bad cell reference ${ref}`);
  return { col: m[1], row: Number(m[2]) };
}
