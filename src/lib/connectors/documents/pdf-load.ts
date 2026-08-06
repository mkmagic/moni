/**
 * The only module that touches `pdfjs-dist`.
 *
 * Kept apart from `pdf-text.ts` on purpose: nothing the Next server bundles may
 * reach pdfjs (a large library with worker and canvas assumptions), so the
 * import lives behind a single function that only the import worker calls —
 * the same containment the existing workers give `israeli-bank-scrapers`
 * (docs/design/connector-interface.md §3).
 */
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { Item } from "./pdf-text";

/** Reads every positioned text run out of a PDF's text layer. */
export async function loadItems(bytes: Uint8Array): Promise<Item[]> {
  const doc = await pdfjs.getDocument({ data: bytes, useSystemFonts: true }).promise;
  try {
    const items: Item[] = [];
    for (let page = 1; page <= doc.numPages; page += 1) {
      const content = await (await doc.getPage(page)).getTextContent();
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
          page,
        });
      }
    }
    return items;
  } finally {
    await doc.destroy();
  }
}
