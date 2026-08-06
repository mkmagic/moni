/**
 * Emits a PDF's positioned text runs as the `Item[]` JSON the document parsers
 * consume — the input format of the test fixtures under
 * `tests/fixtures/long-term-savings/`.
 *
 * Fixtures live at this boundary rather than as committed PDFs for two
 * reasons. This repo is public, and a real statement would publish a ת.ז.,
 * name, balance, salary and employer permanently into git history. And
 * `Item[]` is where the interesting logic starts: label matching, RTL value
 * pairing, header-derived columns and arithmetic all live downstream of it,
 * while `loadItems` itself is a library call with no branching to cover.
 *
 * Redact before committing. `--redact` takes a literal substring and its
 * replacement, applied to every item's text:
 *
 *   npx tsx scripts/dump-pdf-items.mts report.pdf \
 *     --redact 'ישראל ישראלי=מיכל כהן' --redact '212159024=000000018' \
 *     --out tests/fixtures/long-term-savings/harel-pension-q1.json
 *
 * Geometry is left untouched — it is not identifying, and perturbing it would
 * make the fixture stop being a faithful record of how the page is laid out.
 */
import { readFile, writeFile } from "node:fs/promises";
import { loadItems } from "@/lib/connectors/documents/pdf-load";

function usage(): never {
  console.error(
    "usage: npx tsx scripts/dump-pdf-items.mts <file.pdf> [--redact 'from=to' ...] [--out <file.json>]",
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flagged = new Set(
    args.flatMap((arg, i) => (arg === "--redact" || arg === "--out" ? [i + 1] : [])),
  );
  const path = args.find((arg, i) => !arg.startsWith("--") && !flagged.has(i));
  if (!path) usage();
  const out = args[args.indexOf("--out") + 1];

  const redactions: [from: string, to: string][] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== "--redact") continue;
    const pair = args[i + 1];
    const split = pair?.indexOf("=") ?? -1;
    if (split <= 0) usage();
    redactions.push([pair.slice(0, split), pair.slice(split + 1)]);
  }

  const items = (await loadItems(new Uint8Array(await readFile(path)))).map((item) => ({
    ...item,
    text: redactions.reduce((text, [from, to]) => text.split(from).join(to), item.text),
    // Sub-0.1pt precision is noise from the font metrics and only inflates the
    // committed fixture; every tolerance in the parser is points-scale.
    x: Number(item.x.toFixed(1)),
    right: Number(item.right.toFixed(1)),
    y: Number(item.y.toFixed(1)),
    centre: Number(item.centre.toFixed(1)),
  }));

  const leaked = redactions.filter(([from]) => items.some((item) => item.text.includes(from)));
  if (leaked.length) throw new Error(`redaction failed for: ${leaked.map(([f]) => f).join(", ")}`);

  const json = JSON.stringify(items);
  if (out) await writeFile(out, `${json}\n`, "utf8");
  else console.log(json);
}

await main();
