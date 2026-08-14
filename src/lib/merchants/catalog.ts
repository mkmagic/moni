// Layer 1 of merchant resolution: a shipped list of payees we can name
// without asking anyone (docs/adr/0005-*). Pure — no DB, no crypto, no I/O.
//
// Needles are matched against a **match text** (`normalizeDescription`), so
// they are written the way that function leaves a string: lowercased,
// punctuation stripped, spaces collapsed. Hebrew needles are written without
// geresh/gershayim for the same reason.

/** A payee the catalog can name, plus what it takes to render it. */
export interface CatalogEntry {
  /** Stable identity, independent of the display name. Also the asset basename. */
  key: string;
  name: string;
  /** Tints the monogram when there is no asset, and the asset's backdrop when there is. */
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
    logoPath: "/merchants/youtube.svg",
    needles: ["youtube"],
  },
  {
    key: "netflix",
    name: "Netflix",
    brandColor: "#e50914",
    logoPath: "/merchants/netflix.png",
    needles: ["netflix"],
  },
  {
    key: "spotify",
    name: "Spotify",
    brandColor: "#1db954",
    logoPath: "/merchants/spotify.png",
    needles: ["spotify"],
  },
  {
    key: "apple",
    name: "Apple",
    brandColor: "#555555",
    logoPath: "/merchants/apple.png",
    // Never a bare "apple" — it is an ordinary word and a shop name.
    needles: ["apple com bill", "itunes", "apple services"],
  },
  {
    key: "microsoft",
    name: "Microsoft",
    brandColor: "#00a4ef",
    logoPath: "/merchants/microsoft.svg",
    needles: ["microsoft"],
  },
  {
    key: "disney",
    name: "Disney+",
    brandColor: "#113ccf",
    logoPath: "/merchants/disney.svg",
    needles: ["disney"],
  },
  {
    key: "amazon",
    name: "Amazon",
    brandColor: "#ff9900",
    logoPath: "/merchants/amazon.png",
    needles: ["amazon", "aws"],
  },
  {
    key: "google",
    name: "Google",
    brandColor: "#4285f4",
    logoPath: "/merchants/google.png",
    needles: ["google"],
  },
  {
    key: "openai",
    name: "OpenAI",
    brandColor: "#000000",
    logoPath: "/merchants/openai.png",
    needles: ["openai", "open ai", "chatgpt"],
  },
  {
    key: "anthropic",
    name: "Anthropic",
    brandColor: "#191919",
    logoPath: "/merchants/anthropic.png",
    needles: ["anthropic", "claude ai"],
  },
  {
    key: "israel-electric",
    name: "Israel Electric Corporation",
    brandColor: "#f5a800",
    logoPath: "/merchants/israel-electric.png",
    needles: ["israel electric", "iec", "חברת החשמל"],
  },
  {
    key: "meuhedet",
    name: "Meuhedet",
    brandColor: "#6f2c91",
    logoPath: "/merchants/meuhedet.png",
    needles: ["meuhedet", "מאוחדת"],
  },
  {
    key: "clalit",
    name: "Clalit",
    brandColor: "#009a44",
    logoPath: "/merchants/clalit.svg",
    needles: ["clalit", "כללית"],
  },
  {
    key: "leumit",
    name: "Leumit",
    brandColor: "#0072bc",
    logoPath: "/merchants/leumit.png",
    needles: ["leumit", "לאומית"],
  },
  {
    key: "harel",
    name: "Harel",
    brandColor: "#004b87",
    logoPath: "/merchants/harel.svg",
    needles: ["harel", "הראל"],
  },
  {
    key: "ayalon",
    name: "Ayalon",
    brandColor: "#4a0129",
    logoPath: "/merchants/ayalon.svg",
    needles: ["ayalon", "איילון"],
  },
  {
    key: "phoenix",
    name: "Phoenix",
    brandColor: "#f58220",
    logoPath: "/merchants/phoenix.svg",
    needles: ["phoenix", "הפניקס"],
  },
  {
    key: "migdal",
    name: "Migdal",
    brandColor: "#e31e24",
    logoPath: "/merchants/migdal.svg",
    needles: ["migdal", "מגדל"],
  },
  {
    key: "altshuler-shaham",
    name: "Altshuler Shaham",
    brandColor: "#1d2d50",
    logoPath: "/merchants/altshuler-shaham.png",
    needles: ["altshuler shaham", "altshuler", "אלטשולר שחם"],
  },
  {
    key: "meitav",
    name: "Meitav",
    brandColor: "#f58220",
    logoPath: "/merchants/meitav.svg",
    needles: ["meitav dash", "meitav", "מיטב דש", "מיטב"],
  },
  {
    key: "cellcom",
    name: "Cellcom",
    brandColor: "#0033a0",
    logoPath: "/merchants/cellcom.svg",
    needles: ["cellcom", "סלקום"],
  },
  {
    key: "partner",
    name: "Partner",
    brandColor: "#00a9e0",
    logoPath: "/merchants/partner.svg",
    needles: ["partner", "פרטנר"],
  },
  {
    key: "pelephone",
    name: "Pelephone",
    brandColor: "#e4002b",
    logoPath: "/merchants/pelephone.svg",
    needles: ["pelephone", "פלאפון"],
  },
  {
    key: "bezeq",
    name: "Bezeq",
    brandColor: "#003da5",
    logoPath: "/merchants/bezeq.svg",
    needles: ["bezeq", "בזק"],
  },
  {
    key: "hot",
    name: "HOT",
    brandColor: "#e4002b",
    logoPath: "/merchants/hot.svg",
    needles: ["hot", "הוט"],
  },
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

/**
 * What makes two payees the same payee: the catalog key when the catalog
 * knows them, the match text when it doesn't (docs/adr/0005-*).
 *
 * This is what collapses `PAYPAL *NETFLIX` and `NETFLIX` — two different
 * match texts — into one Netflix. It lives here, beside the catalog it
 * consults, because both the merchant writer and the recurring view have to
 * agree on it exactly; when they each had their own copy, a change to one
 * would have split every catalog payee into two rows.
 */
export function merchantIdentity(matchText: string): string {
  return matchCatalog(matchText)?.key ?? matchText;
}
