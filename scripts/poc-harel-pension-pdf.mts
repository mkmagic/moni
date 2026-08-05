/**
 * POC (throwaway): can we deterministically parse a Harel quarterly pension
 * report ("דוח רבעוני בקרן הפנסיה החדשה הראל פנסיה") without an LLM?
 *
 * Run:  npx tsx scripts/poc-harel-pension-pdf.mts <file.pdf> [--json] [--dump]
 *
 * These PDFs carry a real text layer (ComposeDoc 6.0), so there is no OCR and
 * no model in the loop — only pdfjs text items plus their geometry.
 *
 * How it reads the page, and why:
 *   - Hebrew arrives in logical order, numbers are plain ASCII, so no bidi fixups.
 *   - Labelled figures (sections א/ב/ג) are found by matching the Hebrew label
 *     item, then taking the nearest number to its LEFT on the same baseline —
 *     that is where the value column sits in an RTL layout.
 *   - The deposits table (section ה) derives its columns from the header row at
 *     runtime rather than from hardcoded coordinates: stacked header fragments
 *     are merged by x-overlap, and every cell is assigned to the header whose
 *     centre is nearest. A table with an empty column still parses.
 *   - Everything is then cross-checked (balance equation, per-row sums, column
 *     totals) so a silent misread becomes a loud failure.
 *
 * This is NOT wired into the app: no DB, no encryption, no domain layer. Money
 * stays a decimal string end-to-end; Decimal is used only for the checks.
 */
import { readFile } from "node:fs/promises";
import Decimal from "decimal.js";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

// ---------------------------------------------------------------- text items

interface Item {
  text: string;
  /** left edge (PDF user space, origin bottom-left) */
  x: number;
  /** right edge */
  right: number;
  /** baseline */
  y: number;
  centre: number;
  page: number;
}

/** Same-baseline tolerance. Harel stacks rows ~2pt apart in places, so keep it tight. */
const SAME_ROW = 2.5;
/** A value never sits further than this from the label it belongs to. */
const MAX_LABEL_GAP = 140;

const NUMBER = /^-?\d{1,3}(,\d{3})*(\.\d+)?$|^-?\d+(\.\d+)?$/;

async function loadItems(path: string): Promise<Item[]> {
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(await readFile(path)),
    useSystemFonts: true,
  }).promise;

  const items: Item[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    for (const raw of content.items) {
      if (!("str" in raw)) continue;
      const text = raw.str.trim();
      if (!text) continue;
      const x = raw.transform[4] as number;
      items.push({
        text,
        x,
        right: x + raw.width,
        y: raw.transform[5] as number,
        centre: x + raw.width / 2,
        page: p,
      });
    }
  }
  return items;
}

const sameRow = (a: Item, b: Item) => a.page === b.page && Math.abs(a.y - b.y) <= SAME_ROW;
const isNumber = (i: Item) => NUMBER.test(i.text);
const toDecimalString = (text: string) => text.replace(/,/g, "");

function findLabel(items: Item[], predicate: (text: string) => boolean): Item | undefined {
  return items.find((i) => predicate(i.text));
}

/**
 * The number immediately to the left of `label` on the same baseline — the
 * value cell of an RTL label/value pair. Returns null when the cell is blank
 * or holds a dash (Harel prints "-" for "not applicable").
 */
function numberLeftOf(items: Item[], label: Item): string | null {
  let best: Item | undefined;
  for (const i of items) {
    if (i === label || !sameRow(i, label) || i.right > label.x) continue;
    if (label.x - i.right > MAX_LABEL_GAP) continue;
    if (!isNumber(i)) continue;
    if (!best || i.right > best.right) best = i;
  }
  return best ? toDecimalString(best.text) : null;
}

/** True when a "%" glyph abuts the right edge of `value`. */
function hasPercentSign(items: Item[], value: Item): boolean {
  return items.some((i) => i.text === "%" && sameRow(i, value) && Math.abs(i.x - value.right) < 6);
}

// ------------------------------------------------------------------- shapes

interface LabelledAmount {
  label: string;
  amount: string | null;
}

interface DepositRow {
  employer: string;
  depositDate: string;
  forMonth: string;
  salary: string | null;
  employeeContribution: string;
  employerContribution: string;
  severance: string;
  total: string;
}

interface HarelPensionReport {
  source: { file: string; producer: string; pages: number };
  header: {
    documentType: string;
    fundName: string;
    reportDate: string;
    periodStart: string;
    periodEnd: string;
    quarter: string | null;
    year: string | null;
    memberName: string;
    nationalId: string;
  };
  expectedPayments: { retirementAge: string | null; rows: LabelledAmount[] };
  movements: {
    openingBalance: string | null;
    deposits: string | null;
    investmentResult: string | null;
    managementFeesCharged: string | null;
    disabilityInsuranceCost: string | null;
    deathInsuranceCost: string | null;
    closingBalance: string | null;
  };
  managementFees: {
    onDeposit: string | null;
    onSavings: string | null;
    fundAverageOnDeposit: string | null;
    fundAverageOnSavings: string | null;
  };
  investmentTracks: {
    name: string;
    returnPercent: string | null;
    expectedAnnualCostPercent: string | null;
  }[];
  deposits: {
    rows: DepositRow[];
    totals: Omit<DepositRow, "employer" | "depositDate" | "forMonth" | "salary"> | null;
  };
  checks: { name: string; ok: boolean; detail: string }[];
}

// ------------------------------------------------------------------ header

const DATE = String.raw`\d{2}\/\d{2}\/\d{4}`;

function isoDate(ddmmyyyy: string): string {
  const [d, m, y] = ddmmyyyy.split("/");
  return `${y}-${m}-${d}`;
}

function isoMonth(mmyyyy: string): string {
  const [m, y] = mmyyyy.split("/");
  return `${y}-${m}`;
}

function parseHeader(items: Item[]): HarelPensionReport["header"] {
  const text = items
    .filter((i) => i.page === 1)
    .map((i) => i.text)
    .join("\n");

  const grab = (re: RegExp, group = 1): string => {
    const m = text.match(re);
    if (!m) throw new Error(`Header field not found: ${re}`);
    return m[group].trim();
  };

  const period = text.match(new RegExp(String.raw`מתאריך\s*(${DATE})\s*עד תאריך\s*(${DATE})`));
  if (!period) throw new Error("Reporting period not found");

  const quarter = text.match(/לסוף הרבעון ה-(\d+) לשנת (\d{4})/);
  const title = grab(/^(דוח \S+) (?:בקרן הפנסיה החדשה )(.+)$/m, 0);
  const titleParts = title.match(/^(דוח \S+) בקרן הפנסיה החדשה (.+)$/);

  return {
    documentType: titleParts?.[1] ?? title,
    fundName: titleParts?.[2] ?? "",
    reportDate: isoDate(grab(new RegExp(String.raw`תאריך הדוח:\s*(${DATE})`))),
    periodStart: isoDate(period[1]),
    periodEnd: isoDate(period[2]),
    quarter: quarter?.[1] ?? null,
    year: quarter?.[2] ?? null,
    memberName: grab(/שם:\s*(.+?)\s*מספר ת\.ז\./),
    nationalId: grab(/מספר ת\.ז\.\s*(\d+)/),
  };
}

// -------------------------------------------------- sections א / ב / ג / ד

/** Section א — expected payouts. Labels are stable; the retirement age is inline. */
function parseExpectedPayments(items: Item[]): HarelPensionReport["expectedPayments"] {
  const wanted = [
    /^קצבה חודשית הצפויה לך בפרישה בגיל/,
    /^קצבה חודשית לאלמן/,
    /^קצבה חודשית ליתום/,
    /^קצבה חודשית להורה נתמך/,
    /^קצבה חודשית במקרה של נכות/,
    /^שחרור מתשלום הפקדות/,
  ];

  const rows: LabelledAmount[] = [];
  let retirementAge: string | null = null;
  for (const re of wanted) {
    const label = findLabel(items, (t) => re.test(t));
    if (!label) continue;
    const age = label.text.match(/בגיל (\d+)/);
    if (age) retirementAge = age[1];
    rows.push({ label: label.text, amount: numberLeftOf(items, label) });
  }
  return { retirementAge, rows };
}

/** Section ב — movements over the reporting period. */
function parseMovements(items: Item[]): HarelPensionReport["movements"] {
  const at = (re: RegExp): string | null => {
    const label = findLabel(items, (t) => re.test(t));
    return label ? numberLeftOf(items, label) : null;
  };
  return {
    openingBalance: at(/^יתרת הכספים בקרן בתחילת/),
    deposits: at(/^כספים שהופקדו לקרן/),
    // "רווחים" in a good quarter, "הפסדים" in a bad one — the sign carries the meaning.
    investmentResult: at(/^(רווחים|הפסדים) בניכוי הוצאות ניהול השקעות/),
    managementFeesCharged: at(/^דמי ניהול שנגבו/),
    disabilityInsuranceCost: at(/^עלות ביטוח לסיכוני נכות/),
    deathInsuranceCost: at(/^עלות ביטוח למקרה מוות/),
    closingBalance: at(/^יתרת הכספים בקרן בסוף/),
  };
}

/** Section ג — the member's own fee rates, plus the fund-wide average box. */
function parseManagementFees(items: Item[]): HarelPensionReport["managementFees"] {
  const at = (re: RegExp): string | null => {
    const label = findLabel(items, (t) => re.test(t));
    return label ? numberLeftOf(items, label) : null;
  };
  return {
    onDeposit: at(/^דמי ניהול מהפקדה$/),
    onSavings: at(/^דמי ניהול מחיסכון$/),
    // Left-hand box: "ממוצע דמי ניהול בקרן" — labelled by the bare words alone.
    fundAverageOnDeposit: at(/^מהפקדה$/),
    fundAverageOnSavings: at(/^מחיסכון$/),
  };
}

/**
 * Section ד — one row per investment track. Each row is a track name plus two
 * percentages; the rightmost is the return, the next one left is the expected
 * annual cost, matching the printed column order.
 */
function parseInvestmentTracks(items: Item[]): HarelPensionReport["investmentTracks"] {
  const heading = findLabel(items, (t) => /^ד\. מסלולי השקעה/.test(t));
  const footnote = findLabel(items, (t) => /^\*תשואות שהושגו/.test(t));
  if (!heading) return [];
  const top = heading.y - SAME_ROW;
  const bottom = footnote ? footnote.y + SAME_ROW : top - 200;

  const byRow = new Map<number, Item[]>();
  for (const i of items) {
    if (i.page !== heading.page || i.y >= top || i.y <= bottom) continue;
    const key = [...byRow.keys()].find((k) => Math.abs(k - i.y) <= SAME_ROW) ?? i.y;
    (byRow.get(key) ?? byRow.set(key, []).get(key)!).push(i);
  }

  const tracks: HarelPensionReport["investmentTracks"] = [];
  for (const row of [...byRow.entries()].sort((a, b) => b[0] - a[0]).map(([, v]) => v)) {
    const percents = row
      .filter((i) => isNumber(i) && hasPercentSign(row, i))
      .sort((a, b) => b.right - a.right);
    if (percents.length === 0) continue;
    const name = row
      .filter((i) => !isNumber(i) && i.text !== "%")
      .sort((a, b) => b.x - a.x)
      .map((i) => i.text)
      .join(" ");
    tracks.push({
      name,
      returnPercent: percents[0] ? toDecimalString(percents[0].text) : null,
      expectedAnnualCostPercent: percents[1] ? toDecimalString(percents[1].text) : null,
    });
  }
  return tracks;
}

// ------------------------------------------------------- section ה (table)

interface Column {
  title: string;
  centre: number;
}

/**
 * Merge the stacked header fragments into columns by x-overlap, so
 * "תגמולי" over "עובד/ת" becomes one column and its centre anchors the cells
 * beneath it. Derived per document — no coordinates are hardcoded.
 */
function depositColumns(items: Item[], headerAnchor: Item): Column[] {
  const band = items.filter(
    (i) =>
      i.page === headerAnchor.page &&
      i.y <= headerAnchor.y + SAME_ROW &&
      i.y >= headerAnchor.y - 14,
  );

  const groups: Item[][] = [];
  for (const i of [...band].sort((a, b) => b.x - a.x)) {
    const g = groups.find((g) => g.some((j) => i.x < j.right && j.x < i.right));
    if (g) g.push(i);
    else groups.push([i]);
  }

  return groups
    .map((g) => {
      const left = Math.min(...g.map((i) => i.x));
      const right = Math.max(...g.map((i) => i.right));
      return {
        title: g
          .sort((a, b) => b.y - a.y)
          .map((i) => i.text)
          .join(" "),
        centre: (left + right) / 2,
      };
    })
    .sort((a, b) => b.centre - a.centre);
}

function parseDeposits(items: Item[]): HarelPensionReport["deposits"] {
  const anchor = findLabel(items, (t) => t === "מועד");
  const section = findLabel(items, (t) => /^ה\. פירוט הפקדות/.test(t));
  if (!anchor || !section) return { rows: [], totals: null };

  const columns = depositColumns(items, anchor);
  const cellOf = (row: Item[], title: RegExp): Item | undefined => {
    const col = columns.find((c) => title.test(c.title));
    if (!col) return undefined;
    return row.find(
      (i) =>
        columns.reduce((best, c) =>
          Math.abs(c.centre - i.centre) < Math.abs(best.centre - i.centre) ? c : best,
        ) === col,
    );
  };

  // Body rows: below the header block, above the page footer.
  const bodyTop = anchor.y - 14;
  const byRow = new Map<number, Item[]>();
  for (const i of items) {
    if (i.page !== anchor.page || i.y >= bodyTop) continue;
    if (/^עמוד \d+ מתוך/.test(i.text) || /^לתשומת לבך/.test(i.text)) continue;
    if (i.x < 100) continue; // left margin holds the "check your payslip" advice box
    const key = [...byRow.keys()].find((k) => Math.abs(k - i.y) <= SAME_ROW) ?? i.y;
    (byRow.get(key) ?? byRow.set(key, []).get(key)!).push(i);
  }

  const rows: DepositRow[] = [];
  let totals: HarelPensionReport["deposits"]["totals"] = null;

  for (const row of [...byRow.entries()].sort((a, b) => b[0] - a[0]).map(([, v]) => v)) {
    const num = (re: RegExp): string | null => {
      const cell = cellOf(row, re);
      return cell && isNumber(cell) ? toDecimalString(cell.text) : null;
    };

    if (row.some((i) => /^סה"כ$/.test(i.text))) {
      totals = {
        employeeContribution: num(/^תגמולי עובד/) ?? "0",
        employerContribution: num(/^תגמולי מעסיק$/) ?? "0",
        severance: num(/^פיצויים$/) ?? "0",
        total: num(/^סה"כ/) ?? "0",
      };
      break; // the totals row closes the table
    }

    const date = row.find((i) => new RegExp(`^${DATE}$`).test(i.text));
    const month = row.find((i) => /^\d{2}\/\d{4}$/.test(i.text));
    if (!date || !month) continue;

    rows.push({
      employer: row
        .filter((i) => !isNumber(i) && i !== date && i !== month)
        .sort((a, b) => b.x - a.x)
        .map((i) => i.text)
        .join(" "),
      depositDate: isoDate(date.text),
      forMonth: isoMonth(month.text),
      salary: num(/^משכורת$/),
      employeeContribution: num(/^תגמולי עובד/) ?? "0",
      employerContribution: num(/^תגמולי מעסיק$/) ?? "0",
      severance: num(/^פיצויים$/) ?? "0",
      total: num(/^סה"כ/) ?? "0",
    });
  }

  return { rows, totals };
}

// ------------------------------------------------------------------ checks

/**
 * Arithmetic the document must satisfy. Harel rounds every printed figure to
 * the nearest shekel, so sums are allowed to drift by 1 per rounded term.
 */
function runChecks(report: HarelPensionReport): HarelPensionReport["checks"] {
  const checks: HarelPensionReport["checks"] = [];
  const D = (v: string | null) => new Decimal(v ?? "0");

  const m = report.movements;
  if (m.openingBalance && m.closingBalance) {
    const expected = D(m.openingBalance)
      .plus(D(m.deposits))
      .plus(D(m.investmentResult))
      .plus(D(m.managementFeesCharged))
      .plus(D(m.disabilityInsuranceCost))
      .plus(D(m.deathInsuranceCost));
    const diff = expected.minus(D(m.closingBalance)).abs();
    checks.push({
      name: "balance equation",
      ok: diff.lte(3),
      detail: `opening + movements = ${expected.toString()}, printed closing = ${m.closingBalance} (Δ${diff.toString()}, rounding tolerance 3)`,
    });
  }

  for (const row of report.deposits.rows) {
    const sum = D(row.employeeContribution)
      .plus(D(row.employerContribution))
      .plus(D(row.severance));
    checks.push({
      name: `deposit row ${row.forMonth} (${row.employer})`,
      ok: sum.minus(D(row.total)).abs().lte(1),
      detail: `${row.employeeContribution} + ${row.employerContribution} + ${row.severance} = ${sum.toString()} vs total ${row.total}`,
    });
  }

  const t = report.deposits.totals;
  if (t) {
    for (const [key, label] of [
      ["employeeContribution", "תגמולי עובד/ת"],
      ["employerContribution", "תגמולי מעסיק"],
      ["severance", "פיצויים"],
      ["total", 'סה"כ'],
    ] as const) {
      const summed = report.deposits.rows.reduce((acc, r) => acc.plus(D(r[key])), new Decimal(0));
      checks.push({
        name: `column total ${label}`,
        ok: summed.minus(D(t[key])).abs().lte(1),
        detail: `rows sum to ${summed.toString()}, printed total ${t[key]}`,
      });
    }

    if (m.deposits) {
      checks.push({
        name: "deposits table vs movements",
        ok: D(t.total).minus(D(m.deposits)).abs().lte(1),
        detail: `table total ${t.total} vs "כספים שהופקדו לקרן" ${m.deposits}`,
      });
    }
  }

  return checks;
}

// ------------------------------------------------------------------- report

async function parse(path: string): Promise<HarelPensionReport> {
  const items = await loadItems(path);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await readFile(path)) }).promise;
  const info = (await doc.getMetadata()).info as { Producer?: string };

  const report: HarelPensionReport = {
    source: { file: path, producer: info.Producer ?? "", pages: doc.numPages },
    header: parseHeader(items),
    expectedPayments: parseExpectedPayments(items),
    movements: parseMovements(items),
    managementFees: parseManagementFees(items),
    investmentTracks: parseInvestmentTracks(items),
    deposits: parseDeposits(items),
    checks: [],
  };
  report.checks = runChecks(report);
  return report;
}

function print(r: HarelPensionReport): void {
  const shekel = (v: string | null) =>
    v === null ? "—" : `${Number(v).toLocaleString("en-US")} ₪`;
  const pct = (v: string | null) => (v === null ? "—" : `${v}%`);
  const line = (label: string, value: string) => console.log(`  ${label.padEnd(42)} ${value}`);

  console.log(`\n${r.header.documentType} — ${r.header.fundName}`);
  console.log(`${r.source.file}  (${r.source.pages}pp, producer: ${r.source.producer})`);

  console.log("\nמזהי הדוח");
  line("שם", r.header.memberName);
  line("ת.ז.", r.header.nationalId);
  line("תאריך הדוח", r.header.reportDate);
  line("תקופת הדיווח", `${r.header.periodStart} → ${r.header.periodEnd}`);
  line("רבעון / שנה", `Q${r.header.quarter} ${r.header.year}`);

  console.log(
    `\nא. תשלומים צפויים${r.expectedPayments.retirementAge ? ` (גיל פרישה ${r.expectedPayments.retirementAge})` : ""}`,
  );
  for (const row of r.expectedPayments.rows) line(row.label, shekel(row.amount));

  console.log("\nב. תנועות בקרן");
  const m = r.movements;
  line("יתרת הכספים בתחילת השנה", shekel(m.openingBalance));
  line("כספים שהופקדו לקרן", shekel(m.deposits));
  line("רווחים/הפסדים בניכוי הוצאות ניהול", shekel(m.investmentResult));
  line("דמי ניהול שנגבו בשנה זו", shekel(m.managementFeesCharged));
  line("עלות ביטוח לסיכוני נכות", shekel(m.disabilityInsuranceCost));
  line("עלות ביטוח למקרה מוות", shekel(m.deathInsuranceCost));
  line("יתרת הכספים בסוף תקופת הדיווח", shekel(m.closingBalance));

  console.log("\nג. דמי ניהול");
  const f = r.managementFees;
  line("דמי ניהול מהפקדה (שלך)", pct(f.onDeposit));
  line("דמי ניהול מחיסכון (שלך)", pct(f.onSavings));
  line("ממוצע בקרן — מהפקדה", pct(f.fundAverageOnDeposit));
  line("ממוצע בקרן — מחיסכון", pct(f.fundAverageOnSavings));

  console.log("\nד. מסלולי השקעה");
  for (const t of r.investmentTracks) {
    line(
      t.name,
      `תשואה ${pct(t.returnPercent)} · עלות שנתית צפויה ${pct(t.expectedAnnualCostPercent)}`,
    );
  }

  console.log("\nה. פירוט הפקדות");
  const head = [
    "מעסיק",
    "מועד הפקדה",
    "עבור חודש",
    "משכורת",
    "תגמולי עובד",
    "תגמולי מעסיק",
    "פיצויים",
    'סה"כ',
  ];
  const widths = [14, 12, 10, 10, 13, 14, 10, 10];
  const fmt = (cells: (string | null)[]) =>
    "  " + cells.map((c, i) => (c ?? "—").padEnd(widths[i])).join("");
  console.log(fmt(head));
  for (const row of r.deposits.rows) {
    console.log(
      fmt([
        row.employer,
        row.depositDate,
        row.forMonth,
        row.salary,
        row.employeeContribution,
        row.employerContribution,
        row.severance,
        row.total,
      ]),
    );
  }
  if (r.deposits.totals) {
    const t = r.deposits.totals;
    console.log(
      fmt([
        'סה"כ',
        "",
        "",
        "",
        t.employeeContribution,
        t.employerContribution,
        t.severance,
        t.total,
      ]),
    );
  }

  console.log("\nבדיקות עקביות");
  for (const c of r.checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`);
  const failed = r.checks.filter((c) => !c.ok).length;
  console.log(`\n${r.checks.length - failed}/${r.checks.length} checks passed`);
  if (failed > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const path = args.find((a) => !a.startsWith("--"));
  if (!path) {
    console.error("usage: npx tsx scripts/poc-harel-pension-pdf.mts <file.pdf> [--json] [--dump]");
    process.exitCode = 2;
    return;
  }

  if (args.includes("--dump")) {
    for (const i of await loadItems(path)) {
      console.log(
        `p${i.page} y=${i.y.toFixed(1).padStart(7)} x=${i.x.toFixed(1).padStart(6)} r=${i.right.toFixed(1).padStart(6)} ${JSON.stringify(i.text)}`,
      );
    }
    return;
  }

  const report = await parse(path);
  if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else print(report);
}

await main();
