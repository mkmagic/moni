// Labeled merchant strings for `npm run merchant-lookup:poc` (issue #12).
//
// `raw` is written the way a scraper emits it — branch suffixes, card digits,
// punctuation — because the POC runs it through `normalizeDescription` first,
// and half the question is whether a normalized bank string is still enough
// for a model to recognize the merchant.
//
// `expect` is a leaf `key` from `default-categories.ts`, or "unknown" for a
// string nobody should be able to place. The runner rejects a key that is not
// in the shipped set, so a typo here fails loudly instead of scoring as a miss.
//
// `hard: true` marks the cases that decide this feature. Anything the built-in
// table already catches is not evidence — it is the ambiguous, the abbreviated
// and the genuinely-two-categories strings that say whether an external source
// is worth its egress. The runner scores those separately.
//
// THIS FILE IS COMMITTED. Enrich it with merchants you are willing to publish;
// it is not the place for a payee you would rather not put in git.

export interface LookupCase {
  raw: string;
  expect: string;
  hard?: boolean;
  /** Why this case is here, when that is not obvious from the string. */
  note?: string;
}

export const LOOKUP_CASES: LookupCase[] = [
  // --- Real merchants, none of them famous ------------------------------
  //
  // The rows that settled issue #12. Small chains, single branches and street
  // stalls — the population the shipped built-in table will never cover and
  // the local engine cannot reach on day one, because the user has no history
  // yet. If an external source loses anywhere, it should lose here.
  //
  // MEASURED: 12/12. That is what moved this from "worth trying" to a
  // decision. `יאלנס רכבת` below is the counter-example that keeps the claim
  // honest — obscure is fine, obscure AND colliding with a category keyword
  // is not.
  { raw: "דלישס מרכולים זול טו", expect: "food-groceries", hard: true },
  { raw: "אושר עד", expect: "food-groceries", hard: true },
  { raw: "שפע ברכה", expect: "food-groceries", hard: true },
  { raw: "סופר שרונה", expect: "food-groceries", hard: true },
  { raw: "קואופ גבעת אורנים", expect: "food-groceries", hard: true },
  { raw: "מזרח ומערב", expect: "food-groceries", hard: true },
  { raw: "בי פרש קניון מלחה", expect: "food-restaurants", hard: true },
  { raw: "קופר ופאקו שדרות יהודית", expect: "food-restaurants", hard: true },
  { raw: "זלמנס עזריאלי תל אביב", expect: "food-restaurants", hard: true },
  { raw: "רולדין תחנה מרכזית", expect: "food-restaurants", hard: true },
  { raw: "סביח פרישמן עזריאלי", expect: "food-restaurants", hard: true },

  // --- Groceries: the easy floor. If these miss, stop. -------------------
  { raw: "שופרסל דיל רמת גן 4471", expect: "food-groceries" },
  { raw: "יינות ביתן סניף חולון", expect: "food-groceries" },
  { raw: 'ויקטורי שיווק מזון בע"מ', expect: "food-groceries" },
  { raw: 'אושר עד ראשל"צ', expect: "food-groceries" },

  // --- Food out ---------------------------------------------------------
  { raw: "ארומה אספרסו בר", expect: "food-restaurants" },
  { raw: "WOLT TEL AVIV", expect: "food-delivery" },
  { raw: 'תן ביס בע"מ', expect: "food-delivery" },
  { raw: "מקדונלדס דיזנגוף סנטר", expect: "food-restaurants" },

  // --- Transport --------------------------------------------------------
  { raw: 'פז חברת נפט בע"מ 0192', expect: "transport-fuel" },
  { raw: "סונול ישראל", expect: "transport-fuel" },
  { raw: "רב קו טעינה", expect: "transport-public" },
  { raw: "GETT מוניות", expect: "transport-taxi" },
  { raw: "פנגו חניה", expect: "transport-parking" },
  { raw: "סלופארק טכנולוגיות", expect: "transport-parking" },
  {
    raw: "מכון רישוי טסט שנתי",
    expect: "transport-maintenance",
    hard: true,
    note: "The annual car test — Israeli-specific, and once a year, so the local engine never has history for it.",
  },

  // --- Housing & utilities ----------------------------------------------
  { raw: "חברת חשמל לישראל", expect: "housing-electricity" },
  { raw: "מקורות חברת מים", expect: "housing-water" },
  { raw: 'בזק בינלאומי בע"מ', expect: "housing-internet" },
  { raw: "הוט טלקום שותפות", expect: "housing-internet" },
  { raw: 'סלקום ישראל בע"מ', expect: "housing-cellular" },
  { raw: "פרטנר תקשורת", expect: "housing-cellular" },
  {
    raw: "עיריית תל אביב יפו ארנונה",
    expect: "housing-arnona",
    hard: true,
    note: "A municipality bills arnona, water and parking fines on one name.",
  },
  { raw: "ועד בית רחוב הרצל 12", expect: "housing-vaad-bayit", hard: true },

  // --- Health -----------------------------------------------------------
  { raw: "מכבי שרותי בריאות", expect: "health-fund" },
  { raw: "שרותי בריאות כללית", expect: "health-fund" },
  {
    raw: "סופר פארם סניף 231",
    expect: "health-pharmacy",
    hard: true,
    note: "A pharmacy that sells mostly cosmetics — defensible as personal care, and that ambiguity is the point.",
  },

  // --- Insurance: same word, three different leaves ----------------------
  {
    raw: "כלל חברה לביטוח בעמ",
    expect: "financial-insurance",
    hard: true,
    note: "An insurer's name alone does not say life, health or car. If the model resolves these confidently it is guessing.",
  },
  { raw: "הפניקס אחזקות ביטוח", expect: "financial-insurance", hard: true },
  { raw: "הראל ביטוח בריאות", expect: "health-insurance", hard: true },
  {
    raw: "ביטוח ישיר רכב חובה",
    expect: "transport-car-insurance",
    hard: true,
    note: "Only the qualifier distinguishes this from the two above.",
  },

  // --- Subscriptions: arrive through an aggregator ----------------------
  {
    raw: "PAYPAL *NETFLIX.COM",
    expect: "entertainment-subscriptions",
    hard: true,
    note: "Normalizes to `paypal netflix` — the model must read past the aggregator, exactly as ADR 0005 §1 describes.",
  },
  { raw: "SPOTIFY P0A1B2C3", expect: "entertainment-subscriptions" },
  { raw: "GOOGLE *ONE 650-2530000", expect: "entertainment-subscriptions", hard: true },

  // --- Shopping ---------------------------------------------------------
  { raw: 'קסטרו מודל בע"מ', expect: "shopping-clothing" },
  { raw: "איקאה נתניה", expect: "shopping-home" },
  { raw: "KSP COMPUTERS", expect: "shopping-electronics" },
  { raw: "ALIEXPRESS.COM", expect: "shopping-online" },

  // --- Financial & institutional ----------------------------------------
  { raw: "עמלת ניהול חשבון", expect: "financial-bank-fees" },
  {
    raw: "ביטוח לאומי גביה",
    expect: "financial-taxes",
    hard: true,
    note: "Bituach Leumi is income when it pays out and a levy when it collects. `גביה` is the only tell, and the amount — which never leaves — would settle it instantly.",
  },

  // --- The collisions the built-in table documents ----------------------
  {
    raw: "רמי לוי תקשורת סלולר",
    expect: "housing-cellular",
    hard: true,
    note: "Same brand as the supermarket. categorization.md §6 solves it by longest-keyword-wins; the model has to solve it by reading.",
  },
  {
    raw: "יאלנס רכבת",
    expect: "food-restaurants",
    hard: true,
    note: "A café whose name contains `רכבת` (train). The built-in table gets this wrong, and MEASURED: an external model gets it wrong too — it read the same token and answered Public Transport. With the confidence guard it abstains instead, which is the right outcome but not a fix. A single-location business nobody has heard of stays the local engine's job.",
  },

  // --- Should not be placeable -----------------------------------------
  {
    raw: "א.מ.י.ר שיווק והפצה",
    expect: "unknown",
    hard: true,
    note: "A real shape of Israeli bank string: initials plus a generic trade. A model that answers confidently here is hallucinating, and that is worth catching.",
  },
  {
    raw: "חיוב לפי הרשאה 4471",
    expect: "unknown",
    hard: true,
    note: "A standing-order debit with no counterparty in the string at all.",
  },

  // --- Must never be sent (the runner drops these before egress) --------
  {
    raw: "ביט העברה מישראל כהן",
    expect: "transfers-internal",
    note: "A person's name. The egress filter must catch it — if this reaches the provider the filter is broken.",
  },
  {
    raw: "פייבוקס העברת כספים",
    expect: "transfers-internal",
    note: "Same: P2P strings carry people, not merchants.",
  },
];
