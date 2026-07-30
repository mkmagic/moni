# Investment-position connection options

**Question.** Which direct APIs, official exports, and reputable aggregators can
supply positions, cash, valuation, identifiers, currency, and timestamps for
IBKR, Schwab, and Vanguard to a self-hosted Moni deployment?

**Scope and method.** This is a decision input, not an architecture decision.
It was researched on 2026-07-30 from broker and provider documentation only.
"Supported" below means that the cited source documents the mechanism or
product; it does **not** mean that every account type, country, security, or
field is available. Coverage must be confirmed for the user's exact broker and
account during onboarding, particularly for aggregators.

## Moni constraints that change the answer

Moni is self-hosted but multi-user. A connection credential, API token,
refresh token, report token, account identifier, holding quantity/value, and
the imported position payload are sensitive. The connection must therefore be
per-user, encrypted before its first database write with the credential key,
and decrypted only in the credential-unlock window; it must be invoked through
the domain/service layer under RLS. These are direct applications of
[Moni's security principles](../../security/security-design-principles.md) and
the existing [connector design](../../design/connector-interface.md).

The existing worker's account-password handling is deliberately narrow: it is
a spawn-per-sync residual for a scraper that requires JavaScript strings. A
broker OAuth/report token is still Tier-0 and must be wipeable binary where
possible, encrypted at rest, never logged, and revoked/deleted when the user
disconnects. Do not treat an aggregator's HTTPS/OAuth flow as a reason to relax
those requirements. For all provider API responses, parse numeric fields as
untrusted input and turn them into exact decimal strings before money/holding
processing; provider schemas commonly define these values as `number`/`double`.

No examined mechanism makes the self-hosted running app unable to see the data:
it must process plaintext while importing. They can, however, avoid ever giving
Moni the broker password and can narrowly limit/revoke delegated access.

## Comparison

| Mechanism | Brokers / field fit | Consent and read-only boundary | Lifecycle / self-hosting fit | Cost, terms, and operational burden |
| --- | --- | --- | --- | --- |
| **IBKR Flex Web Service** | IBKR only. A user constructs an Activity or Trade Confirmation Flex Query in Client Portal, then Moni retrieves the generated report. Select report sections/columns to include positions, cash, NAV/valuation, instrument identifiers/currency, and statement timestamps; validate the exact XML fields in a test account. Activity data updates daily; trade confirmations lag executions about 5–10 minutes. | The report template and token are created by the user in Client Portal. The documented service generates/retrieves preconfigured reports; it has no order endpoint, so this integration can expose only those two GET report calls. The token may expose every linked account included in the query. | Token lifetime is user-selected from 6 hours to one year; user can regenerate it and can restrict source IPs. It is sent as a URL query parameter in the documented API, so request URLs must never reach access logs, proxies, error reporting, or browser history. No callback, public hostname, or continuously running local gateway is required. Poll no more than daily for Activity reports; account for two-step generation, pacing (1/s, 10/min/token), expiry, and retryable not-ready responses. | Officially supported report API and relatively low implementation complexity. Still requires user setup and encrypted token custody. Confirm account/report entitlement and any applicable IBKR agreement with the user; the sources reviewed do not publish an incremental API fee. [IBKR Flex documentation](https://www.interactivebrokers.com/campus/ibkr-api-page/flex-web-service/) · [token configuration](https://www.interactivebrokers.com/docs/web-api/flex-web-service/flex-web-service/client-portal-configuration/enable-and-create-access-token) |
| **IBKR Client Portal Web API via local gateway** | IBKR only. `/portfolio/{accountId}/positions/{pageId}` returns positions (including IB contract ID); ledger/account endpoints can supply cash/valuation. It is capable of intraday data, unlike Flex. | Not an inherently read-only credential: the same API includes trading. Moni could whitelist only non-`/iserver` portfolio GET endpoints, but the authenticated IBKR session is broader authority, so this is a weaker least-privilege fit than Flex. | Individual clients must run IBKR's Java Client Portal Gateway locally, authenticate in a browser on that same machine, and call the API from that same machine. IBKR says it is unsupported to operate it remotely and requires reauthentication at least daily. Its localhost certificate needs user handling; do **not** copy IBKR examples that disable certificate verification. This conflicts with a central self-hosted server unless the user's browser/host runs an additional local agent. | Highest operating complexity: Java/gateway lifecycle, daily user intervention, session contention, host placement, TLS, and an endpoint allow-list. API requires active, funded IBKR Pro accounts and 2FA. IBKR says individual authentication cannot be automated and cautions against third-party session solutions. [IBKR Web API requirements and gateway limits](https://www.interactivebrokers.com/campus/ibkr-api-page/cpapi-v1/) |
| **IBKR TWS API / IB Gateway** | IBKR only. Position callbacks include account, contract, decimal position and average cost; account updates can provide cash/portfolio values. | Also a trading-capable API/session, not a delegated read-only grant. A read-only configuration/allow-list would be an operational convention rather than a provider-scoped data consent. | Requires a live TWS/IB Gateway session and its operational/security maintenance; unsuitable as a simple unattended server connector without separately proving the account/session configuration. | Mature official interface but high integration and support burden; validate required market-data/entitlements and exact valuation/currency fields. [IBKR TWS API portfolio and positions](https://www.interactivebrokers.com/campus/ibkr-api-page/twsapi-doc/) |
| **Schwab Trader API** | Schwab only. The official product is the direct route to account/position data; use its current Accounts and Trading specification to map securities, quantities, market values, cash balances, identifiers, currencies, and timestamps before committing to field completeness. | OAuth user consent, rather than a stored Schwab password, is the intended model. It is a trading API, so a Moni connector must request/use only account-read scopes/endpoints and never implement order endpoints; confirm the scope names and production application approval in the current Schwab developer portal. | Requires a registered developer app and HTTPS redirect/callback. Store the per-user OAuth refresh token as Tier-0, bind callback state/PKCE, handle expiry/revocation, and give the user reconnect/revoke UX. A public, stable HTTPS callback is needed, which is material for a self-hosted installation behind NAT. | Direct, likely best field fidelity for Schwab but has production registration/approval and OAuth operations. The public portal, not this report, is authoritative for its then-current approval, quotas, costs, terms, and scope policy. [Schwab Developer Portal](https://developer.schwab.com/) |
| **Official user-mediated exports/statements** | **Vanguard:** the official support page explicitly lists CSV downloads and Quicken/Money downloadable transactions; it also supports online statements. **Schwab:** official account statements are downloadable as PDFs for the prior 10 years, and Schwab documents Quicken transaction download. **IBKR:** Flex queries/reports are the stronger official structured export. Position/cash/current value/identifier/timestamp availability depends on the selected export/statement; CSV/PDF must be field-tested. | User downloads the file and uploads/imports it; Moni stores no broker credential, long-lived token, callback registration, or third-party link. This is the clearest read-only boundary. | No automatic refresh; timestamp is the export's "as of" time, not ingestion time. Import needs an explicit account mapping, duplicate/revision handling, exact-decimal parser, format/version tests, and a review/error screen. Never automate website login/download merely because an export exists. | Lowest secret exposure and vendor/API cost; lowest legal/API-access uncertainty; recurring user work and format drift are the trade-offs. PDFs may be suitable as evidence but are a poorer canonical source than a structured CSV/OFX/QFX-like export. [Vanguard technical support](https://investor.vanguard.com/technical-support) · [Schwab statements and Quicken FAQ](https://www.schwab.com/client-faqs) |
| **Plaid Investments** | One normalized API for participating US/Canada institutions, including investment accounts. Holdings include security metadata, quantity, institution price/value and price timestamps; account balances include current/available value/cash where the institution supplies them. Coverage and field quality are institution-specific. Schwab requires explicit production access and may take up to six weeks; establish Vanguard/IBKR availability for the exact accounts in Plaid's live coverage tool before promising support. | User goes through Plaid Link/OAuth where supported; Moni receives a Plaid `access_token`, not necessarily the broker password. This is data retrieval only from Moni's perspective, but Plaid is an additional processor and some connections may need user-present update/repair. | Link needs a registered redirect URI/OAuth setup for OAuth institutions and a webhook endpoint for updates. Tokens must be encrypted; handle `OAUTH_INVALID_TOKEN`, webhooks, consent expiry, one-Schwab-OAuth-Item-per-user-per-app, and reconnect. Updates are generally overnight; paid on-demand refresh is not real-time and is not supported by every institution. Public HTTPS webhook/callback reachability is a self-hosting deployment requirement. | Investments is subscription-priced; Investments Refresh is paid per request; exact production price and agreement govern. Production and institution approvals add vendor/onboarding operations. It is lowest code effort for multi-broker coverage but largest data-processor/vendor dependency. [Plaid Investments overview](https://plaid.com/docs/investments/) · [API fields and refresh](https://plaid.com/docs/api/products/investments/) · [OAuth/Schwab constraints](https://plaid.com/docs/link/oauth/) · [billing](https://plaid.com/docs/account/billing/) |
| **Akoya Accounts & Investments** | Normalized FDX-style Accounts & Investments returns account/balance details plus holdings and (where provided) investment attributes; tax lots include identifiers, quantity, cost basis/current value and purchase date. Provider-specific coverage must be checked in the Data Recipient Hub for IBKR, Schwab, and Vanguard—public generic docs do not establish all three. | Akoya describes the product as 100% user-permissioned and never scraped. OAuth/OIDC redirects let the financial institution authenticate the user; Moni receives delegated tokens, not credentials. This is a strong credential-exposure profile, but it remains a third-party processor. | Register exact HTTPS redirect URI, use consent UX, save client secret/tokens encrypted, and implement OAuth authorization-code/refresh/revocation. Documented access ID tokens should be treated as about 15 minutes (provider varies); refresh-token expiry is provider-set. V3 also requires interaction/last-access/intent headers, which makes background syncing subject to provider policy. | Requires Data Recipient Hub account, sandbox/testing, and production-access request. Price is provider/contract-specific (obtain quote/terms). Moderate implementation complexity and strong standardized-consent posture, contingent on target broker coverage. [Akoya investment API](https://docs.akoya.com/reference/investments) · [consent/token lifecycle](https://docs.akoya.com/guides/account-linking-and-consent-use-case) · [redirect requirements](https://docs.akoya.com/guides/redirect-uris-explained) |
| **SnapTrade Connection Portal** | Brokerage-focused normalized API. Confirm current support for each of IBKR, Schwab, Vanguard and the account country/type in its live broker picker—do not infer coverage from examples. | Its hosted connection portal can send a user to the brokerage sign-in page and supports a `read` connection mode as distinct from `trade`; Moni must request `read` only and never add trading endpoints. This keeps broker credentials out of Moni when the brokerage supports direct sign-in, but adds SnapTrade as processor. | Hosted portal handles login, MFA and repair; the completed callback supplies a connection ID. The login URL expires after five minutes. Backend authentication uses an app consumer key plus a per-user secret; store both encrypted, keep them out of browser code, and rotate/reconnect on compromise or disabled connection. Callback means a public HTTPS endpoint remains necessary. | Potentially lower broker-specific code than direct APIs, but coverage/terms and production pricing must be contracted/verified. It is a material external data path even with read mode. [Connection Portal](https://docs.snaptrade.com/docs/implement-connection-portal) · [login URL expiry](https://docs.snaptrade.com/reference/Authentication/Authentication_loginSnapTradeUser) · [authentication](https://docs.snaptrade.com/docs/authentication-methods) |
| **Flanks Connect Sessions** | Investment-data aggregator with a connection lifecycle designed for custodians; verify all three target brokers and available fields through the provider before treating it as coverage. | User gets a unique, non-reusable hosted connection session for sign-in, credential update and MFA; Moni sees the result/status rather than automating the broker website. Some custodians require a signed authorization letter. | Client-credentials access tokens last one hour. Session return must be verified server-side; build explicit states for MFA/invalid credentials/user action. Use the current Connect Sessions integration: its first-party documentation says older Flanks Link endpoints are no longer maintained and will shut down on 2026-12-31. | Enterprise-style onboarding, legal authorization for some custodians, and no published price found make this a high operational/commercial-burden option for a family self-host. [authentication](https://docs.flanks.io/pages/flanks-apis/authentication/) · [Connect Sessions](https://docs.flanks.io/pages/concepts/connect-sessions/) · [authorization letters](https://docs.flanks.io/pages/flanks-apis/letters-api/) · [Link deprecation](https://docs.flanks.io/pages/flanks-link/flanks-link/) |

## Recommendation-ready conclusions (without selecting an architecture)

1. **A no-secret manual path exists for all three brokers and should remain a
   viable baseline.** It is the only option that is clearly applicable to
   Vanguard from public first-party material reviewed here, avoids a public
   callback and long-lived third-party access, and has an intrinsically
   read-only authority boundary. Its downside is manual refresh and
   broker-format-specific import work.

2. **For IBKR, Flex is the direct automation candidate that best preserves a
   read-only design.** It is report-scoped rather than a trading session and
   works from a self-hosted server without a browser callback. Its token is
   powerful within the report's linked-account scope and appears in query URLs,
   so treat it as a high-impact Tier-0 secret and configure a short lifetime
   and IP restriction where the user's deployment has stable egress.

3. **Schwab direct OAuth is plausible but is not automatically a small
   self-hosted feature.** It needs developer approval, stable HTTPS redirect
   handling, token lifecycle/reconnect UX, and strict read-only endpoint/scope
   enforcement because the product also trades. Verify its live terms, scopes,
   quotas, and allowed personal/self-hosted use with Schwab before building.

4. **No public direct Vanguard API was identified in the first-party sources
   reviewed.** Do not infer one from Quicken/CSV support, nor scrape the
   Vanguard website. Vanguard's terms also describe downloaded site material
   as personal, informational, noncommercial use, which reinforces a
   user-export/import treatment rather than automated collection or
   redistribution. [Vanguard terms](https://investor.vanguard.com/ts/pdf/terms_and_conditions.pdf)
   The supported choices evidenced here are user-mediated export or an
   aggregator after its live coverage/contract confirmation.

5. **Plaid and Akoya reduce per-broker implementation, not security work.**
   They add a data processor, production onboarding, callbacks/webhooks,
   encrypted token storage, consent repair, coverage variation, and recurring
   commercial cost. They are candidates when the owner accepts those tradeoffs
   and confirms the exact three broker/account combinations; they are not a
   coverage guarantee from their generic product pages.

## Due diligence before any implementation

- Obtain written/current confirmation of each broker's and aggregator's
  production eligibility for a personal, self-hosted, multi-user application,
  geographic/account-type coverage, read scopes, retention/use restrictions,
  data-processing terms, price, rate limits, and revocation behavior.
- Collect redacted real samples from each chosen mechanism and make a field
  matrix: stable account/security IDs, quantity, quantity units, cash,
  position/current value, price and **as-of** time, currency at every monetary
  field, cost basis, and market-data delay. Treat a missing currency or
  timestamp as unknown, never as USD/now.
- Make connection creation/update/sync/revocation service-layer operations;
  RLS-test cross-user isolation and encrypt tokens/payload fields before first
  write. Build a user-initiated sync first; do not assume a scheduler exists.
- For OAuth, use authorization-code flow with PKCE, state/nonce validation,
  exact registered HTTPS redirect URI, and a callback that carries no tokens
  into logs. For webhooks, authenticate/verify them and expose only the needed
  endpoint.
- For every connector, test disconnect/revoke, expired/rotated token,
  connection repair, duplicate/revised positions, partial import failure, and
  provider outage. Promotion must be atomic and must not silently replace a
  position snapshot with incomplete data.
