# Future returns, lots, and Israeli tax: data 1.1 must not lose

**Decision boundary.** This is a forward-compatibility research note for issue
[#35](https://github.com/mkmagic/moni/issues/35), not a design for investment,
tax-return, or order-routing functionality. “Must preserve” means that the
information has a credible later use and cannot be reconstructed faithfully
from a balance or a period aggregate.

## Findings from primary sources

### Israeli tax and currency facts

- The Israel Tax Authority’s current traded-securities attachment (form 1325)
  is for real capital gain from traded securities and sends its totals to the
  annual return; it distinguishes rate categories. Form 1322 is the related
  annual-return attachment for securities. This makes annual, transaction-level
  evidence and withholding evidence necessary inputs to a later estimate, not
  merely a portfolio return series. [ITA form 1325, tax year
  2025](https://www.gov.il/BlobFolder/service/reporting-and-payment-2025-annual-tax-report-for-individuals/he/Service_Pages_Income_tax_annual-report-2026_1325-2025-ACC.pdf)
  and [ITA form 1322, tax year
  2025](https://www.gov.il/BlobFolder/service/reporting-and-payment-2025-annual-tax-report-for-individuals/he/Service_Pages_Income_tax_annual-report-2026_1322-2025-ACC.pdf).
- The ITA’s 2025 professional directive, applying the Moses ruling, says that
  for an individual’s foreign-currency-denominated or FX-linked security the
  exchange rate is treated as the index. Its worked examples calculate the
  purchase and sale values in ILS using the respective dates’ FX rates and
  separate a real gain from the inflationary amount. A later Israeli estimate
  therefore needs **both** acquisition-date and disposal-date currency facts,
  per matched quantity; a single account-level FX rate or today’s rate is not
  sufficient. [ITA professional directive
  2025/10](https://www.gov.il/BlobFolder/policy/professional-directives-271125-1/he/IncomeTax_professional-directives-271125-1.pdf).
- Bank of Israel (BoI) representative rates are daily ILS-per-foreign-currency
  indicators, not necessarily transaction rates and not legally binding. BoI
  does not publish them on every calendar day and does not guarantee publication
  on every day. Its series API documents a daily USD/ILS representative-rate
  series. Thus a tax/FX module must retain the rate actually used and its source
  and must make any non-publication-date convention explicit; it must not silently
  substitute a broker conversion or a neighbouring date’s rate. [BoI: what a
  representative rate is](https://www.boi.org.il/roles/markets/reprate/) and
  [BoI series/API guide](https://www.boi.org.il/information/bank-paymnts/guide/api-guide/).
- The ITA provides a cost-determination process for traded securities precisely
  because a member’s recorded cost can differ from the taxpayer’s declared cost,
  and requires documentation supporting the declared original cost. Preserve
  source documents and corrections rather than treating broker cost basis as
  unquestionable ground truth. [ITA form 746 service](https://www.gov.il/en/service/application-determining-cost-traded-securities).

These are tax facts, not a conclusion that Moni can calculate a filing. Tax
treatment depends on residence, taxpayer status, security type, dates,
withholding, other income/losses, elections, and authoritative guidance current
at filing. A later feature must be labelled an estimate and require review by an
Israeli tax professional; it must not generate a return or assert legal advice.

### Broker records are evidence, not the tax authority

For a concrete US-broker example, IBKR says its non-US annual statement reports
trade detail and gain/loss using FIFO or the account’s selected tax-accounting
method; its dividend report contains dividends and withholding. IBKR also permits
users to select lot-matching methods and manually match sales to open lots. This
shows why an imported broker’s realized gain, tax method, or lot match must be
stored as attributable broker evidence, while Moni preserves enough raw data to
perform a separate lawful analysis later. It does **not** establish an Israeli
tax lot rule or authorize Moni to transmit a disposal instruction. [IBKR,
non-US year-end reports](https://www.interactivebrokers.com/en/support/tax-nonus-reports.php)
and [IBKR tax-management tools](https://www.interactivebrokers.com/en/support/tax-management-and-reporting.php).

IBKR’s API documentation also says statements contain transaction detail and can
be produced for a requested date range, but availability is limited. Retain each
imported statement/export (or its encrypted raw payload and integrity metadata)
when ingested; do not rely on later redownload. [IBKR activity-statement
documentation](https://www.interactivebrokers.com/docs/web-api/account-management/reporting/activity-statements).

## Preservation constraints for 1.1

The following are product choices derived from those facts and from Moni’s
existing exact-decimal, encrypted, append-only-raw-ledger rules. They do not add
a trade/lot/tax feature in 1.1.

1. **Keep immutable source evidence.** Retain encrypted raw broker payloads,
   statement/export identity and period, broker/account identifiers, source-row
   identifiers, import time, and a content integrity value. Retain corrections,
   reconciliation/supersession links, and the original rather than overwriting
   it. `sync_staging` already points in this direction; its retention must cover
   investment imports too.
2. **Do not collapse a trade into a balance or an aggregate.** For every future
   acquisition, disposal, transfer-in/out, fee, cash conversion, income event,
   and corporate-action adjustment, preserve its immutable economic event date
   (and execution timestamp/time zone when supplied), settlement date when
   supplied, direction, exact quantity and unit, gross price/proceeds, trade
   currency, commissions/fees/taxes and their currencies, and net cash movement.
   All amounts, prices, quantities, and rates remain exact decimal strings;
   no float or display rounding becomes source data.
3. **Preserve durable instrument identity.** Store the provider’s instrument
   identifier plus ISIN when supplied, exchange/venue, currency, asset class,
   and symbol/name as historical labels. Symbols and names alone are not stable
   enough through listings or corporate actions. Do not merge records solely by
   ticker.
4. **Preserve acquisition lineage before any sale.** A later sale must be able
   to refer to one or more original acquisition event IDs and exact partial
   quantities. Keep explicit broker-reported lot matches/method and user/tax
   adviser overrides separately from the source event, with actor, time, reason,
   and evidence. If no matching data exists, record “unknown”; never manufacture
   FIFO (or another method). This keeps future comparison of *lawful* disposal
   choices analytical and read-only in v1.1.
5. **Record FX as tax evidence, not only dashboard conversion.** For each
   acquisition and disposal retain the native trade-currency amounts and an
   immutable ILS conversion record: rate value, quote convention (for example
   ILS per one USD), rate date/time, source/published-series ID, retrieval time,
   and status. Keep separately any broker’s actual conversion/fill and fee.
   Existing flow `fx_rate`/`fx_rate_date` may be a useful display conversion,
   but must not be the only retained rate if it lacks the tax-rate convention or
   an acquisition/disposal-specific source.
6. **Keep corporate actions and basis-affecting events as first-class evidence.**
   Preserve links from a split, merger, spin-off, return of capital, option
   exercise/assignment, transfer, or broker basis adjustment to the affected
   instrument/event/lot, including quantity and basis adjustments and source
   document. A position snapshot cannot recreate those transformations.
7. **Retain income and tax-withholding evidence independently of trades.**
   Preserve dividend/interest/payment type, gross amount and currency, payment
   date, foreign withholding amount/currency/jurisdiction, Israeli withholding
   if any, and broker/authority form or statement reference. Do not infer this
   from a net cash credit.
8. **Preserve valuation observations for returns without rewriting history.**
   For each balance/holding valuation retain as-of date/time, quantity, native
   value, price/rate, currency, source, and whether it is broker-asserted or
   market-derived. Returns later require dated external cash flows plus values;
   retroactively replacing a historical mark destroys reproducibility.
9. **Apply Moni’s existing safety boundary.** All user-owned investment evidence,
   amounts, quantities, account identifiers, source documents, and notes are
   Tier-1 encrypted; owner/RLS and composite owner FKs apply to every new table;
   provenance is append-only/auditable; the domain layer remains the sole access
   path. An agent may only read within the live-key boundary and cannot select
   lots, place a trade, or write tax data in v1.1.

## Deliberately deferred decisions

- Whether Israeli reporting requires a particular lot-identification ordering in
  a given case, which exact published rate/date convention applies, and treatment
  of each asset/corporate-action type need current professional advice and should
  be resolved when a tax module is scoped.
- Whether Moni will use BoI representative rates, a legally appropriate
  alternative, broker-conversion rates, or show several reconciled views is a
  future policy decision. The retained provenance above keeps it reversible.
- Performance methodology (money-weighted/time-weighted), accounting treatment,
  tax-estimate formulas, cross-account netting, and US tax rules are out of
  scope. US broker lot controls are evidence of available data and user choice,
  not a recommendation or a statement of Israeli law.

## Compatibility check against current Moni design

Current documents already require exact decimal strings, encrypted user money,
transaction-date locked FX for flows, raw-entry retention, structural
provenance, RLS, and `entry_trades`/`securities`/`holdings` as deferred extension
points. The gap to avoid in 1.1 is data loss: future investment ingestion must
not reduce a trade to `security_id`, `qty`, and `price`, or reduce it to an
account snapshot. The constraints above preserve the additional evidence while
leaving the later module’s schema and calculations deliberately open.
