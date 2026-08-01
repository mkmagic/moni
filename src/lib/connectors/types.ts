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
export type ConnectorKind = "bank" | "credit_card" | "investment";
export type ConnectorMode = "credentialed_fetch" | "user_mediated_import";

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
  | "schwab_positions_csv";

export interface ConnectorDefinition {
  id: ConnectorId;
  /** Human-readable institution name — used for UI and default account naming. */
  label: string;
  kind: ConnectorKind;
  mode: ConnectorMode;
  /** Ordered to match the scraper's expected credentials-object key order. */
  loginFields: LoginFieldDescriptor[];
}
