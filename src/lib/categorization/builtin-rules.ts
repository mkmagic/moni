// Built-in categorization rules — the shipped Israeli merchant keyword table.
//
// These are code constants, not DB rows: they carry no `owner_id`, raise no
// RLS question, and improve with an app upgrade rather than being frozen
// into every user's account at signup. They are evaluated *after* the user's
// own rules, so a user rule (or a learned one) always wins
// (docs/design/categorization.md).
//
// EDITING THIS FILE IS THE INTENDED WAY TO IMPROVE COVERAGE. Add a merchant
// by adding its `match` strings; no migration, no seed, no backfill.
//
// Matching contract: each `match` string is tested as a substring of
// `normalizeDescription(entry.description)`, so write them the way that
// function emits — lowercase, no punctuation, no runs of 4+ digits. Hebrew
// is unaffected by case folding. Order within this array is irrelevant;
// ties are resolved by the longest matching string, so a specific merchant
// beats a generic keyword.
//
// `categoryKey` must be a `key` from default-categories.ts. A rule pointing
// at a key the user has deleted simply doesn't fire.

export interface BuiltinRule {
  /** Stable identifier, for debugging and for the `Built-in` UI label. */
  key: string;
  /** Normalized substrings; any one matching assigns `categoryKey`. */
  match: string[];
  categoryKey: string;
  /**
   * Restricts the rule to entries held on an account of this classification.
   * Only the card-settlement rule needs it: the issuer's name means "I paid
   * off the card" on a bank account and "the issuer charged me a fee" on the
   * card itself, and those are opposite answers.
   */
  onlyOn?: "asset" | "liability";
}

export const BUILTIN_RULES: BuiltinRule[] = [
  // --- Groceries ---------------------------------------------------------
  { key: "shufersal", match: ["שופרסל", "shufersal"], categoryKey: "food-groceries" },
  { key: "rami-levy", match: ["רמי לוי", "rami levy"], categoryKey: "food-groceries" },
  { key: "yochananof", match: ["יוחננוף", "yochananof"], categoryKey: "food-groceries" },
  { key: "victory", match: ["ויקטורי", "victory"], categoryKey: "food-groceries" },
  { key: "osher-ad", match: ["אושר עד"], categoryKey: "food-groceries" },
  { key: "tiv-taam", match: ["טיב טעם", "tiv taam"], categoryKey: "food-groceries" },
  { key: "mega", match: ["מגה בעיר", "יינות ביתן"], categoryKey: "food-groceries" },
  { key: "am-pm", match: ["am pm", "ampm", "אי אם פי אם"], categoryKey: "food-groceries" },
  { key: "makolet", match: ["מכולת", "ירקן", "מאפיית", "קצביית"], categoryKey: "food-groceries" },

  // --- Restaurants & cafés ----------------------------------------------
  { key: "aroma", match: ["ארומה", "aroma"], categoryKey: "food-restaurants" },
  { key: "cofix", match: ["קופיקס", "cofix"], categoryKey: "food-restaurants" },
  { key: "landwer", match: ["לנדוור", "landwer"], categoryKey: "food-restaurants" },
  { key: "cafe-greg", match: ["קפה גרג", "greg"], categoryKey: "food-restaurants" },
  { key: "mcdonalds", match: ["מקדונלד", "mcdonald"], categoryKey: "food-restaurants" },
  { key: "burger", match: ["בורגר", "burger"], categoryKey: "food-restaurants" },
  { key: "pizza", match: ["פיצה", "pizza", "דומינוס"], categoryKey: "food-restaurants" },
  { key: "japanika", match: ["ג׳פניקה", "גפניקה", "japanika"], categoryKey: "food-restaurants" },
  {
    key: "restaurant-generic",
    match: ["מסעדת", "מסעדה", "בית קפה"],
    categoryKey: "food-restaurants",
  },

  // --- Food delivery -----------------------------------------------------
  { key: "wolt", match: ["וולט", "wolt"], categoryKey: "food-delivery" },
  { key: "tenbis", match: ["תן ביס", "10bis", "tenbis"], categoryKey: "food-delivery" },
  { key: "cibus", match: ["סיבוס", "cibus"], categoryKey: "food-delivery" },

  // --- Fuel --------------------------------------------------------------
  { key: "paz", match: ["פז ", "yellow", "פזומט"], categoryKey: "transport-fuel" },
  { key: "delek", match: ["דלק ", "menta", "מנטה"], categoryKey: "transport-fuel" },
  { key: "sonol", match: ["סונול", "sonol", "סו גוד"], categoryKey: "transport-fuel" },
  {
    key: "ten-fuel",
    match: ["טן דלק", "דור אלון", "alonit", "אלונית"],
    categoryKey: "transport-fuel",
  },

  // --- Public transport / taxi ------------------------------------------
  {
    key: "rav-kav",
    match: ["רב קו", "רב קב", "rav kav", "hopon"],
    categoryKey: "transport-public",
  },
  { key: "egged", match: ["אגד", "egged"], categoryKey: "transport-public" },
  { key: "israel-railways", match: ["רכבת ישראל", "רכבת"], categoryKey: "transport-public" },
  {
    key: "dan-metropoline",
    match: ["דן בעמ", "מטרופולין", "קווים"],
    categoryKey: "transport-public",
  },
  { key: "moovit", match: ["moovit", "מוביט", "פנגו", "pango"], categoryKey: "transport-parking" },
  { key: "gett", match: ["gett", "גט טקסי", "get taxi"], categoryKey: "transport-taxi" },
  { key: "yango", match: ["yango", "יאנגו"], categoryKey: "transport-taxi" },
  { key: "cellopark", match: ["סלופארק", "cellopark", "חניון"], categoryKey: "transport-parking" },
  {
    key: "kvish-6",
    match: ["כביש 6", "כביש חוצה ישראל", "דרך ארץ"],
    categoryKey: "transport-parking",
  },

  // --- Car ---------------------------------------------------------------
  {
    key: "car-test",
    match: ["טסט רכב", "רישוי רכב", "משרד הרישוי"],
    categoryKey: "transport-car-insurance",
  },
  {
    key: "car-insurance",
    match: ["ביטוח רכב", "ביטוח חובה"],
    categoryKey: "transport-car-insurance",
  },
  {
    key: "car-garage",
    match: ["מוסך", "צמיגים", "טרייד אין"],
    categoryKey: "transport-maintenance",
  },

  // --- Utilities ---------------------------------------------------------
  {
    key: "electric-company",
    match: ["חברת החשמל", "חשמל לישראל"],
    categoryKey: "housing-electricity",
  },
  {
    key: "electricity-private",
    match: ["אלקטרה פאוואר", "פזגז חשמל", "סלקום אנרגי"],
    categoryKey: "housing-electricity",
  },
  {
    key: "water",
    match: ["מי אביבים", "מקורות", "תאגיד המים", "מי שבע"],
    categoryKey: "housing-water",
  },
  {
    key: "arnona",
    match: ["ארנונה", "עיריית", "מועצה מקומית", "מועצה אזורית"],
    categoryKey: "housing-arnona",
  },
  { key: "vaad-bayit", match: ["ועד בית", "ועד הבית"], categoryKey: "housing-vaad-bayit" },

  // --- Telecom -----------------------------------------------------------
  { key: "bezeq", match: ["בזק", "bezeq"], categoryKey: "housing-internet" },
  { key: "hot", match: ["hot ", "הוט "], categoryKey: "housing-internet" },
  { key: "yes", match: ["די בי אס", "yes פלוס"], categoryKey: "housing-internet" },
  { key: "partner", match: ["פרטנר", "partner", "אורנג"], categoryKey: "housing-cellular" },
  { key: "cellcom", match: ["סלקום", "cellcom"], categoryKey: "housing-cellular" },
  { key: "pelephone", match: ["פלאפון", "pelephone"], categoryKey: "housing-cellular" },
  {
    key: "golan",
    match: ["גולן טלקום", "golan telecom", "רמי לוי תקשורת"],
    categoryKey: "housing-cellular",
  },

  // --- Health ------------------------------------------------------------
  { key: "clalit", match: ["כללית", "clalit"], categoryKey: "health-fund" },
  {
    key: "maccabi",
    match: ["מכבי שרותי", "מכבי בריאות", "maccabi health"],
    categoryKey: "health-fund",
  },
  { key: "meuhedet", match: ["מאוחדת", "meuhedet"], categoryKey: "health-fund" },
  { key: "leumit", match: ["לאומית שרותי", "leumit"], categoryKey: "health-fund" },
  {
    key: "super-pharm",
    match: ["סופר פארם", "super pharm", "superpharm"],
    categoryKey: "health-pharmacy",
  },
  { key: "be-pharm", match: ["בי פארם", "ניו פארם"], categoryKey: "health-pharmacy" },
  {
    key: "dental",
    match: ["מרפאת שיניים", "רופא שיניים", "אורתודנט"],
    categoryKey: "health-dental",
  },

  // --- Subscriptions -----------------------------------------------------
  { key: "netflix", match: ["netflix", "נטפליקס"], categoryKey: "entertainment-subscriptions" },
  { key: "spotify", match: ["spotify", "ספוטיפיי"], categoryKey: "entertainment-subscriptions" },
  {
    key: "youtube",
    match: ["youtube", "google youtube"],
    categoryKey: "entertainment-subscriptions",
  },
  { key: "disney", match: ["disney"], categoryKey: "entertainment-subscriptions" },
  {
    key: "apple-services",
    match: ["apple com bill", "itunes"],
    categoryKey: "entertainment-subscriptions",
  },
  {
    key: "google-services",
    match: ["google storage", "google one"],
    categoryKey: "entertainment-subscriptions",
  },
  {
    key: "openai",
    match: ["openai", "anthropic", "claude ai"],
    categoryKey: "entertainment-subscriptions",
  },

  // --- Entertainment -----------------------------------------------------
  {
    key: "cinema",
    match: ["סינמה סיטי", "יס פלאנט", "רב חן", "לב קולנוע"],
    categoryKey: "entertainment-culture",
  },
  {
    key: "gym",
    match: ["הולמס פלייס", "גו אקטיב", "איקס פיט", "קאנטרי"],
    categoryKey: "entertainment-sports",
  },
  {
    key: "airlines",
    match: ["אל על", "el al", "ויזאיר", "wizz", "ryanair"],
    categoryKey: "entertainment-travel",
  },
  {
    key: "hotels",
    match: ["booking com", "airbnb", "מלון", "fattal", "פתאל"],
    categoryKey: "entertainment-travel",
  },

  // --- Shopping ----------------------------------------------------------
  {
    key: "fashion",
    match: ["קסטרו", "castro", "פוקס", "zara", "רנואר", "renuar"],
    categoryKey: "shopping-clothing",
  },
  { key: "shoes", match: ["scoop", "נעלי", "foot locker"], categoryKey: "shopping-clothing" },
  { key: "ikea", match: ["ikea", "איקאה"], categoryKey: "shopping-home" },
  { key: "home-stores", match: ["הום סנטר", "home center", "אייס"], categoryKey: "shopping-home" },
  {
    key: "electronics",
    match: ["ksp", "קספי", "באג", "אלקטריק"],
    categoryKey: "shopping-electronics",
  },
  {
    key: "online-marketplaces",
    match: ["aliexpress", "amazon", "ebay", "shein", "temu"],
    categoryKey: "shopping-online",
  },

  // --- Financial ---------------------------------------------------------
  {
    key: "bank-fees",
    match: ["עמלת", "עמלות", "דמי ניהול חשבון", "דמי כרטיס"],
    categoryKey: "financial-bank-fees",
  },
  // The aggregate monthly charge the card issuer debits from the bank
  // account. Classified as a TRANSFER, not an expense — the purchases behind
  // it are already in the ledger as entries on the card account, so treating
  // this as spending double-counts every one of them.
  //
  // `onlyOn: "asset"` is what keeps that correct in the other direction: the
  // same issuer name appearing on the card account is a real fee, and must
  // still land in Credit Card Fees below.
  {
    key: "card-settlement",
    match: [
      "ישראכרט",
      "isracard",
      "כרטיסי אשראי לישראל",
      "מקס איט",
      "max it",
      // Deliberately not the bare "כאל" or "cal": matching is substring-based
      // with no word boundary, and "כאל" is inside "למכאל" — paying a person
      // named מיכאל would be swallowed as a card settlement.
      "ויזה כאל",
      "כרטיסי אשראי",
      "לאומי קארד",
      "leumi card",
      "אמריקן אקספרס",
      "american express",
    ],
    categoryKey: "transfers-card-payment",
    onlyOn: "asset",
  },
  { key: "loan", match: ["הלוואה", "החזר הלוואה", "משכנתא"], categoryKey: "financial-loans" },
  { key: "tax", match: ["מס הכנסה", "מעמ", "רשות המסים"], categoryKey: "financial-taxes" },
  {
    key: "insurance",
    match: ["הראל", "מגדל ביטוח", "כלל ביטוח", "הפניקס", "מנורה מבטחים"],
    categoryKey: "financial-insurance",
  },
  {
    key: "investments",
    match: ["קרן השתלמות", "קופת גמל", "גמל להשקעה", "פנסיה"],
    categoryKey: "financial-savings",
  },

  // --- Income ------------------------------------------------------------
  {
    key: "salary",
    match: ["משכורת", "שכר עבודה", "salary", "payroll"],
    categoryKey: "income-salary",
  },
  // Bituach Leumi is genuinely ambiguous — an allowance (income) for most
  // households, a levy (expense) for the self-employed. Mapped to income
  // because that is the common case; a user rule overrides it, as always.
  {
    key: "bituach-leumi",
    match: ["ביטוח לאומי", "בטוח לאומי"],
    categoryKey: "income-national-insurance",
  },
  { key: "interest", match: ["ריבית זכות", "דיבידנד"], categoryKey: "income-investments" },
  { key: "refund", match: ["זיכוי", "החזר כספי", "refund"], categoryKey: "income-refunds" },

  // --- Transfers & cash --------------------------------------------------
  { key: "atm", match: ["כספומט", "משיכת מזומן", "atm "], categoryKey: "transfers-cash" },
  {
    key: "internal-transfer",
    match: ["העברה עצמית", "העברה בין חשבונות", "העברה לחשבון"],
    categoryKey: "transfers-internal",
  },
  { key: "p2p", match: ["ביט העברה", "paybox", "פייבוקס"], categoryKey: "transfers-internal" },

  // --- Services ----------------------------------------------------------
  {
    key: "education",
    match: ["גן ילדים", "בית ספר", "אוניברסיטת", "מכללת", "שכר לימוד"],
    categoryKey: "services-education",
  },
  { key: "childcare", match: ["צהרון", "מעון", "בייביסיטר"], categoryKey: "services-childcare" },
  {
    key: "personal-care",
    match: ["מספרה", "ספא", "קוסמטיק"],
    categoryKey: "services-personal-care",
  },

  // --- Giving ------------------------------------------------------------
  {
    key: "charity",
    match: ["תרומה", "עמותת", "צדקה", "לתת", "יד שרה"],
    categoryKey: "giving-charity",
  },
];
