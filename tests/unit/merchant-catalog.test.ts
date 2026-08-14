// src/lib/merchants/catalog.ts — the shipped pattern -> merchant lookup, the
// first of the three layers that write a merchant row (docs/adr/0005-*).
// Matching happens on the normalized match text, so every needle here is
// already lowercased, punctuation-stripped and space-collapsed.
import { describe, expect, it } from "vitest";
import { normalizeDescription } from "@/lib/categorization/normalize";
import { matchCatalog } from "@/lib/merchants/catalog";

/** Matching runs on a match text, never on a raw bank description. */
const match = (raw: string) => matchCatalog(normalizeDescription(raw));

describe("matchCatalog", () => {
  it("resolves a bare merchant name", () => {
    expect(match("NETFLIX")?.name).toBe("Netflix");
  });

  it("resolves through a card-processor prefix — the reason matching is contains, not equality", () => {
    // "PAYPAL *NETFLIX" normalizes to "paypal netflix"; an exact-match catalog
    // would miss every card-routed subscription in the country.
    expect(match("PAYPAL *NETFLIX")?.name).toBe("Netflix");
  });

  it("resolves a Hebrew merchant name", () => {
    expect(match("סלקום")?.name).toBe("Cellcom");
  });

  it("returns null for a payee it has never heard of", () => {
    expect(match("ג'ופניקה תל אביב")).toBeNull();
  });

  it("does not mistake a hotel for HOT — needles match whole words, not substrings", () => {
    // The trap that makes raw `String.includes` unusable here: HOT is an
    // Israeli cable company and "hot" is a prefix of "hotel".
    expect(match("HOTEL TEL AVIV")).toBeNull();
    expect(match("HOT MOBILE")?.name).toBe("HOT");
  });

  it("matches a multi-word needle only when the words are adjacent and in order", () => {
    expect(match("APPLE.COM/BILL")?.name).toBe("Apple");
    expect(match("APPLE ORCHARD BILL PAYMENT")).toBeNull();
  });

  it("carries a brand colour, which is what tints the fallback monogram", () => {
    expect(match("NETFLIX")?.brandColor).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("never carries a logo path that leaves the origin (ADR 0007)", () => {
    // The invariant is not 'every merchant has an icon' — it's that no icon
    // is ever fetched from somewhere else. An entry with no asset yet renders
    // a brand-tinted monogram, which is a complete answer, not a placeholder.
    for (const raw of ALL_SAMPLES) {
      const entry = match(raw);
      if (entry?.logoPath == null) continue;
      expect(entry.logoPath).toMatch(/^\/merchants\/[a-z0-9-]+\.(?:png|svg)$/);
    }
  });

  it("points every catalog merchant at its bundled asset", () => {
    for (const raw of ALL_SAMPLES) {
      const entry = match(raw);
      expect(entry?.logoPath).toMatch(new RegExp(`^/merchants/${entry?.key}\\.(?:png|svg)$`));
    }
  });

  it("gives every catalog entry a unique key, so a merchant can't be seeded twice", () => {
    const keys = CATALOG_KEYS();
    expect(new Set(keys).size).toBe(keys.length);
  });
});

/** One raw description per catalog entry, as a bank would emit it. */
const ALL_SAMPLES = [
  "NETFLIX",
  "SPOTIFY",
  "APPLE.COM/BILL",
  "GOOGLE *ONE",
  "YOUTUBEPREMIUM",
  "MICROSOFT*365",
  "AMAZON",
  "DISNEY PLUS",
  "סלקום",
  "פרטנר",
  "פלאפון",
  "בזק",
  "HOT MOBILE",
  "חברת החשמל לישראל",
  "CHATGPT PLUS",
  "ANTHROPIC CLAUDE",
  "מאוחדת",
  "כללית",
  "לאומית",
  "הראל ביטוח",
  "איילון ביטוח",
  "הפניקס פנסיה",
  "מגדל ביטוח",
  "אלטשולר שחם",
  "מיטב דש",
];

/** Reads the keys back through the public surface rather than the module internals. */
function CATALOG_KEYS(): string[] {
  return ALL_SAMPLES.map((s) => matchCatalog(normalizeDescription(s))?.key).filter(
    (k): k is string => k != null,
  );
}
