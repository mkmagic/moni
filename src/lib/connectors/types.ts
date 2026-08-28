// Connector registry types — the login-field shape each supported
// israeli-bank-scrapers connector expects, plus which kind of account it
// represents. This is a thin, purely descriptive layer: the real scraper API
// types (ScraperCredentials, CompanyTypes, SCRAPERS) live in the
// israeli-bank-scrapers package itself; tests/unit/connector-registry.test.ts
// is what keeps registry.ts from drifting out of sync with the library's
// real login-field list.

/** What kind of account a connector represents — drives account-type
 * inference at scrape-promotion time (src/domain/sync-promotion.ts) and the
 * onboarding picker's grouping (a later cluster, not built here). */
export type ConnectorKind = "bank" | "credit_card" | "investment" | "long_term_savings";
export type ConnectorMode = "credentialed_fetch" | "user_mediated_import";

/**
 * For a `user_mediated_import` connector, the file the importer reads. Absent
 * on `credentialed_fetch` connectors, which fetch rather than take a file.
 *
 * Load-bearing at exactly two edges — the upload dialog's accepted file type
 * and the sync route's magic-byte check plus worker choice — so a connector
 * whose format differs from the long-term-savings default (a PDF single
 * statement) states it here rather than having those edges special-case its id.
 * `xlsx` is also what marks the multi-account aggregator apart from a
 * single-document report: it carries no connector-level `product`, because the
 * product varies per account inside the file.
 */
export type ImportFormat = "pdf" | "csv" | "xlsx";

/**
 * The kinds whose connector id is an israeli-bank-scrapers `SCRAPERS` key. The
 * registry drift gate only applies to these; everything else reaches its
 * provider by some other route entirely.
 */
export const SCRAPER_BACKED_KINDS: readonly ConnectorKind[] = ["bank", "credit_card"];

/**
 * Which long-term-savings product a connector's documents describe. Set only
 * on `long_term_savings` connectors — one parser reads one product's report
 * layout, so the product is a property of the connector, not something the
 * user picks.
 */
export type LongTermSavingsProduct =
  "pension" | "hishtalmut" | "gemel" | "gemel_investment" | "managers_insurance";

export type LoginFieldInputType = "text" | "password";

/** One credential field a connector's login form needs, in the order the
 * scraper's `ScraperCredentials` object expects the keys. */
export interface LoginFieldDescriptor {
  /** Matches the key israeli-bank-scrapers expects in its credentials object
   * (e.g. "username", "password", "card6Digits"). */
  key: string;
  /** Human-readable label for a login form. */
  label: string;
  inputType: LoginFieldInputType;
}

/** Supported connector ids — a deliberate subset of the library's
 * `CompanyTypes`. `oneZero` is excluded: it needs OTP, which this registry's
 * plain login-field shape can't express. */
export type ConnectorId =
  | "leumi"
  | "mizrahi"
  | "otsarHahayal"
  | "max"
  | "visaCal"
  | "union"
  | "beinleumi"
  | "massad"
  | "pagi"
  | "hapoalim"
  | "isracard"
  | "amex"
  | "discount"
  | "mercantile"
  | "yahav"
  | "ibkr_flex"
  | "schwab_positions_csv"
  | "snaptrade"
  | "harel_pension_quarterly"
  | "harel_hishtalmut"
  | "agam_liderim";

export interface ConnectorDefinition {
  id: ConnectorId;
  /** Human-readable name of the connector itself, e.g. "Interactive Brokers Flex". */
  label: string;
  /**
   * The institution an account reached through this connector actually belongs
   * to — "Charles Schwab", not "Schwab Positions CSV". Undefined for an
   * aggregator like SnapTrade, which can reach many brokerages and therefore
   * reports the institution per account instead.
   */
  institutionLabel?: string;
  kind: ConnectorKind;
  /**
   * Set on a `long_term_savings` connector that imports a single provider's
   * statement, whose product is a property of the connector. The multi-account
   * aggregator (`agam_liderim`) leaves it undefined: one file carries pension,
   * גמל and השתלמות accounts at once, so the product is decided per account at
   * promotion time, not by the connector.
   */
  product?: LongTermSavingsProduct;
  /** Set on `user_mediated_import` connectors; the file the importer reads. */
  importFormat?: ImportFormat;
  mode: ConnectorMode;
  /** Ordered to match the scraper's expected credentials-object key order. */
  loginFields: LoginFieldDescriptor[];
}
