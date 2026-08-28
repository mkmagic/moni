/**
 * A tiny .xlsx writer for the Agam Liderim parser tests — the inverse of the
 * reader under test. It builds a real DEFLATE zip with the worksheet skeleton
 * the parser reads (workbook + rels + sheets), so the tests can generate
 * portfolio workbooks with any number of rows, blanked cells, or a wrong sheet
 * name, all from dummy data.
 *
 * Hebrew is emitted as numeric character references, exactly as the real export
 * stores it, so the tests also exercise the parser's entity decoding. That the
 * reader also handles a genuine Excel-generated file is confirmed separately
 * against a real export; this writer is deliberately minimal and only feeds the
 * one reader.
 */
import { deflateRawSync } from "node:zlib";

/** CRC-32 (IEEE), computed directly so the writer needs no zlib version check. */
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let b = 0; b < 8; b++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const body = deflateRawSync(file.data);
    const crc = crc32(file.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const localBuf = Buffer.concat(locals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

/** Hebrew (and anything non-ASCII) as numeric character references, like the export. */
function xmlText(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === "&") out += "&amp;";
    else if (ch === "<") out += "&lt;";
    else if (ch === ">") out += "&gt;";
    else if (code > 127) out += `&#${code};`;
    else out += ch;
  }
  return out;
}

/** A cell value: a string, a number, or null for an empty cell. */
export type CellValue = string | number | null;

const COLS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function colLetter(index: number): string {
  return COLS[index];
}

function sheetXml(rows: CellValue[][]): string {
  let body = "";
  rows.forEach((cells, r) => {
    const rowNum = r + 1;
    let rowXml = "";
    cells.forEach((value, c) => {
      if (value === null) return;
      const ref = `${colLetter(c)}${rowNum}`;
      if (typeof value === "number") {
        rowXml += `<c r="${ref}" t="n"><v>${value}</v></c>`;
      } else {
        rowXml += `<c r="${ref}" t="inlineStr"><is><t>${xmlText(value)}</t></is></c>`;
      }
    });
    body += `<row r="${rowNum}">${rowXml}</row>`;
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

export interface SheetSpec {
  name: string;
  rows: CellValue[][];
}

/** Builds an .xlsx workbook from the given sheets (first sheet is sheet1). */
export function buildXlsx(sheets: SheetSpec[]): Buffer {
  const sheetTags = sheets
    .map((s, i) => `<sheet name="${xmlText(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join("");
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetTags}</sheets></workbook>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
    )
    .join("")}</Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets
    .map(
      (_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join("")}</Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

  const files = [
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(rootRels, "utf8") },
    { name: "xl/workbook.xml", data: Buffer.from(workbook, "utf8") },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(rels, "utf8") },
    ...sheets.map((s, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: Buffer.from(sheetXml(s.rows), "utf8"),
    })),
  ];
  return zip(files);
}

/** The balances sheet's tab name and header labels, matching the real export. */
export const BALANCES_SHEET = "מוצרים ויתרות";
export const HEADER_ROW = [
  "סוג מוצר",
  "שם יצרן",
  "נכונות מידע",
  "מספר פוליסה/ חשבון",
  "שם מוצר",
  "סטטוס",
  "תאריך הצטרפות",
  "צבירה כוללת",
];

/** One account row in the header column order above. */
export interface AccountRow {
  productType: CellValue;
  provider: CellValue;
  infoDate: CellValue;
  policyNumber: CellValue;
  productName: CellValue;
  status: CellValue;
  joinDate: CellValue;
  balance: CellValue;
}

function accountCells(row: AccountRow): CellValue[] {
  return [
    row.productType,
    row.provider,
    row.infoDate,
    row.policyNumber,
    row.productName,
    row.status,
    row.joinDate,
    row.balance,
  ];
}

export interface PortfolioOptions {
  banner?: string | null;
  sheetName?: string;
  header?: CellValue[];
  rows: AccountRow[];
  /** A trailing totals row (balance present, no product type) to be excluded. */
  totalsBalance?: number | null;
  /** A second, unrelated sheet, as the real workbook carries. */
  extraSheet?: boolean;
}

/**
 * A whole balances workbook from dummy account rows, laid out banner → header →
 * data → optional totals, matching the real export's shape.
 */
export function buildPortfolio(opts: PortfolioOptions): Buffer {
  const rows: CellValue[][] = [];
  rows.push([null, null, opts.banner === undefined ? "הופק בתאריך: 28/08/2026" : opts.banner]);
  rows.push([]); // spacer
  rows.push(opts.header ?? HEADER_ROW);
  for (const account of opts.rows) rows.push(accountCells(account));
  if (opts.totalsBalance !== undefined && opts.totalsBalance !== null) {
    // Totals row: only the balance column is filled, no product type.
    const totals: CellValue[] = [null, null, null, null, null, null, null, opts.totalsBalance];
    rows.push(totals);
  }
  const sheets: SheetSpec[] = [{ name: opts.sheetName ?? BALANCES_SHEET, rows }];
  if (opts.extraSheet) sheets.push({ name: "מסלולי השקעה וביצועי קופות", rows: [["x"]] });
  return buildXlsx(sheets);
}
