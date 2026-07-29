// Layer 1 of merchant resolution: a shipped list of payees we can name
// without asking anyone (docs/adr/0005-*). Pure — no DB, no crypto, no I/O.
//
// Needles are matched against a **match text** (`normalizeDescription`), so
// they are written the way that function leaves a string: lowercased,
// punctuation stripped, spaces collapsed. Hebrew needles are written without
// geresh/gershayim for the same reason.

/** A payee the catalog can name, plus what it takes to render it. */
export interface CatalogEntry {
  /** Stable identity, independent of the display name. Also the SVG basename. */
  key: string;
  name: string;
  /** Tints the monogram when there is no SVG, and the SVG's backdrop when there is. */
  brandColor: string;
  /**
   * Origin-local path to a bundled icon, or null when no asset has been added
   * for this merchant yet — in which case a brand-tinted monogram renders.
   * **Never an external URL** (docs/adr/0007-*).
   */
  logoPath: string | null;
  /** Any one of these, matched against the match text, resolves this entry. */
  needles: string[];
}

/**
 * Ordered most-specific first: a YouTube Premium charge often arrives as
 * `GOOGLE *YOUTUBE`, which both entries would claim, and the first match
 * wins.
 */
const CATALOG: CatalogEntry[] = [
  {
    key: "youtube",
    name: "YouTube",
    brandColor: "#ff0000",
    logoPath: null,
    needles: ["youtube"],
  },
  { key: "netflix", name: "Netflix", brandColor: "#e50914", logoPath: null, needles: ["netflix"] },
  { key: "spotify", name: "Spotify", brandColor: "#1db954", logoPath: null, needles: ["spotify"] },
  {
    key: "apple",
    name: "Apple",
    brandColor: "#555555",
    logoPath: null,
    // Never a bare "apple" — it is an ordinary word and a shop name.
    needles: ["apple com bill", "itunes", "apple services"],
  },
  {
    key: "microsoft",
    name: "Microsoft",
    brandColor: "#00a4ef",
    logoPath: null,
    needles: ["microsoft"],
  },
  { key: "disney", name: "Disney+", brandColor: "#113ccf", logoPath: null, needles: ["disney"] },
  {
    key: "amazon",
    name: "Amazon",
    brandColor: "#ff9900",
    logoPath: null,
    needles: ["amazon", "aws"],
  },
  { key: "google", name: "Google", brandColor: "#4285f4", logoPath: null, needles: ["google"] },
  {
    key: "cellcom",
    name: "Cellcom",
    brandColor: "#0033a0",
    logoPath: null,
    needles: ["cellcom", "סלקום"],
  },
  {
    key: "partner",
    name: "Partner",
    brandColor: "#00a9e0",
    logoPath: null,
    needles: ["partner", "פרטנר"],
  },
  {
    key: "pelephone",
    name: "Pelephone",
    brandColor: "#e4002b",
    logoPath: null,
    needles: ["pelephone", "פלאפון"],
  },
  { key: "bezeq", name: "Bezeq", brandColor: "#003da5", logoPath: null, needles: ["bezeq", "בזק"] },
  { key: "hot", name: "HOT", brandColor: "#e4002b", logoPath: null, needles: ["hot", "הוט"] },
];

/**
 * Below this length a needle must match a whole token; at or above it, a
 * token may merely start with the needle.
 *
 * Both halves are load-bearing. Without the prefix rule `YOUTUBEPREMIUM` —
 * one token once normalized — resolves to nothing. Without the length guard
 * the three-letter cable company HOT claims every hotel in the country.
 */
const PREFIX_MIN_LENGTH = 5;

function tokenMatches(token: string, needle: string): boolean {
  return needle.length >= PREFIX_MIN_LENGTH ? token.startsWith(needle) : token === needle;
}

/** True when the needle's words appear in the text, adjacent and in order. */
function needleMatches(tokens: string[], needle: string): boolean {
  const needleTokens = needle.split(" ");
  for (let i = 0; i + needleTokens.length <= tokens.length; i++) {
    if (needleTokens.every((n, j) => tokenMatches(tokens[i + j], n))) return true;
  }
  return false;
}

/**
 * Resolves a match text to a known merchant, or null when the catalog has
 * never heard of it — which is the ordinary case, and why layer 2 auto-creates
 * a merchant from the match text itself.
 */
export function matchCatalog(matchText: string): CatalogEntry | null {
  if (matchText === "") return null;
  const tokens = matchText.split(" ");
  return CATALOG.find((e) => e.needles.some((n) => needleMatches(tokens, n))) ?? null;
}
