# What Moni 1.1 should borrow from Finlynq and Ghostfolio

**Decision-oriented research for issue #34 — 2026-07-30.** This is a reference
study, not a screen design. It examined the checked-out source at Finlynq
[`1720f33`](https://github.com/finlynq/finlynq/tree/1720f33d462ede75fbe68515df99315f48cde957)
and Ghostfolio
[`e339d8c`](https://github.com/ghostfolio/ghostfolio/tree/e339d8ca8b8d1a01fa585cc6099b1373e8576cf8),
including their source history/CHANGELOGs, against Moni's committed model.

## Bottom line

Borrow **information architecture and honest data-quality language**, not either
application's storage or calculation architecture. The smallest 1.1 reference
set is: one investment entry point; a compact value/as-of summary; an
account-aware, sortable holdings list with a safe drill-down; a small number of
allocation cuts; and an explicit unavailable/stale state. Keep calculations in
Moni's domain layer and defer trade, performance, and look-through analytics
until their required data model exists.

## What the references actually implement

| Concern | Finlynq | Ghostfolio | Useful conclusion |
| --- | --- | --- | --- |
| Navigation | A portfolio landing page composes overview, holdings, allocation, benchmark and account sections ([page](https://github.com/finlynq/finlynq/blob/1720f33d462ede75fbe68515df99315f48cde957/src/app/(app)/portfolio/page.tsx)). | An authenticated portfolio route has analysis, activities, allocations, FIRE and X-ray children ([routes](https://github.com/ghostfolio/ghostfolio/blob/e339d8c/apps/client/src/app/pages/portfolio/portfolio-page.routes.ts)). | One entry point and progressively deeper destinations are a good pattern; 1.1 need not inherit the breadth. |
| Summary and holdings | Finlynq exposes totals/type buckets plus canonical holding rollups, filters, sortable columns, empty-position hiding, native/reporting currency choice, per-account expansion and CSV ([page](https://github.com/finlynq/finlynq/blob/1720f33d462ede75fbe68515df99315f48cde957/src/app/(app)/portfolio/page.tsx), [table](https://github.com/finlynq/finlynq/blob/1720f33d462ede75fbe68515df99315f48cde957/src/app/(app)/portfolio/_components/holdings-table.tsx)). | Ghostfolio offers a table/treemap holding view and holding click-through ([holdings](https://github.com/ghostfolio/ghostfolio/blob/e339d8c/apps/client/src/app/components/home-holdings/home-holdings.html)); its summary distinguishes investment, gross/net performance, fees, cash and total assets ([summary](https://github.com/ghostfolio/ghostfolio/blob/e339d8c/apps/client/src/app/components/portfolio-summary/portfolio-summary.component.html)). | Borrow the hierarchy, stable sorting and account-to-holding drill-down. Treat performance/cost-basis columns as later capabilities, not implied 1.1 fields. |
| Allocations and drill-down | Finlynq derives type/account allocation plus optional ETF sector/region look-through ([page](https://github.com/finlynq/finlynq/blob/1720f33d462ede75fbe68515df99315f48cde957/src/app/(app)/portfolio/page.tsx)). | Ghostfolio groups allocation by platform, currency, asset class, holding, sector, continent, market, country and account; holding/account charts are clickable ([allocations](https://github.com/ghostfolio/ghostfolio/blob/e339d8c/apps/client/src/app/pages/portfolio/allocations/allocations-page.html)). | Borrow a limited allocation cut and click-to-filter/drill-down relationship. Sector/region/country require trusted security metadata and are future work. |
| Value history and snapshots | Finlynq builds per-account and whole-portfolio daily snapshots and records a `gapsFilled` quality flag ([builder](https://github.com/finlynq/finlynq/blob/1720f33d462ede75fbe68515df99315f48cde957/src/lib/portfolio/snapshots/builder.ts)); its history work is explicitly scheduled in instrumentation ([scheduler](https://github.com/finlynq/finlynq/blob/1720f33d462ede75fbe68515df99315f48cde957/src/instrumentation.ts)). | Ghostfolio computes portfolio snapshots through a queue and caches an expiry of zero when snapshot errors exist ([processor](https://github.com/ghostfolio/ghostfolio/blob/e339d8c/apps/api/src/services/queues/portfolio-snapshot/portfolio-snapshot.processor.ts)). | Borrow the distinction between a historical value and its data-quality state. Do not adopt a scheduler/queue now: Moni has neither background-job mechanism in scope nor `pg-boss` installed. |
| Provider seam and operational state | Finlynq has an on-read price cache with a 30-minute same-day TTL, retained last-known quote fallback, timeout and negative-cache protection ([price service](https://github.com/finlynq/finlynq/blob/1720f33d462ede75fbe68515df99315f48cde957/src/lib/price-service.ts)); it also logs outbound provider failures ([market fetch](https://github.com/finlynq/finlynq/blob/1720f33d462ede75fbe68515df99315f48cde957/src/lib/market-fetch.ts)). | Ghostfolio defines provider operations for profile, quote, historical, dividend and search data ([interface](https://github.com/ghostfolio/ghostfolio/blob/e339d8c/apps/api/src/services/data-provider/interfaces/data-provider.interface.ts)), chooses a configured/mapped provider ([service](https://github.com/ghostfolio/ghostfolio/blob/e339d8c/apps/api/src/services/data-provider/data-provider.service.ts)), and renders health as Available/Unavailable ([component](https://github.com/ghostfolio/ghostfolio/blob/e339d8c/apps/client/src/app/components/data-provider-status/data-provider-status.component.ts)). | Borrow a narrow provider contract and explicit provenance/freshness/error outcome. Keep provider calls out of request-path valuation unless Moni's committed connector/FX design says otherwise. |

## Patterns to borrow in 1.1

1. **Make each displayed number answer “what, when, and how complete?”** The
   provenance/freshness signal is more valuable than a live-price flourish.
   For Moni, the source of truth is the latest account balance snapshot; its
   date/source and a clearly incomplete/pending state travel with the read
   result. This aligns with `account_balance_snapshots` as the sole absolute
   balance store and its explicit scrape/manual source
   ([Moni data model](../../design/data-model.md)).
2. **Use holdings → account membership as the drill-down boundary.** Finlynq's
   canonical row expanded to account rows is the right *relationship*, while
   Ghostfolio's chart/table click-through demonstrates that an allocation must
   lead somewhere useful. In Moni, both levels must be served by the same
   owner-scoped domain read; no client-side aggregation of raw tenant data.
3. **Prefer a compact, composable read model.** A summary, holdings list,
   allocation buckets and a value series can be independent domain projections,
   rather than a monolithic “portfolio calculator.” That lets the page remain
   useful before pricing, trade lots, or analytics exist.
4. **Expose absence rather than manufacture precision.** Ghostfolio's provider
   health result and Finlynq's stale-cache work both show why upstream quality
   must be visible. Moni should distinguish no snapshot, failed source, stale
   snapshot and pending FX/valuation—not turn any of them into zero or a
   current-price estimate.

## Patterns Moni must reject

| Reference pattern | Why it conflicts | Moni constraint |
| --- | --- | --- |
| Finlynq represents money/prices and aggregates with JavaScript `number`/SQL numeric arithmetic (e.g. typed `number` aggregations in its [overview route](https://github.com/finlynq/finlynq/blob/1720f33d462ede75fbe68515df99315f48cde957/src/app/api/portfolio/overview/route.ts)). | It cannot meet Moni's exact-decimal requirement. | Sensitive money/holding values are encrypted exact decimals; decrypt and aggregate with `decimal.js`, never a float ([data model](../../design/data-model.md), [money](../../design/money-and-currency.md)). |
| Finlynq re-prices holdings and FX from request-time “today” rates in its portfolio overview ([overview route](https://github.com/finlynq/finlynq/blob/1720f33d462ede75fbe68515df99315f48cde957/src/app/api/portfolio/overview/route.ts)). | Today's rate is appropriate only for a stock valuation as-of today, not historical flows; a UI currency choice must not make history drift. | Lock flow FX at transaction date; value stocks at the requested as-of rate; pending FX remains unavailable ([data model](../../design/data-model.md), [money](../../design/money-and-currency.md)). |
| Either app's direct data-access/calculator surface. | Moni has one service/domain access path, with RLS as a backstop; a feature-local portfolio query or cache writer is a second path. | Every user-owned table has RLS and owner-scoped composite foreign keys, and every read/write passes through the domain layer ([domain layer](../../design/domain-layer.md), [security principles](../../security/security-design-principles.md)). |
| Treating holdings, quantities, symbols, account identities or valuations as ordinary plaintext portfolio data. | These are Tier-1 sensitive fields in Moni, and must be encrypted before the first write. | Ciphertext at rest, keys only in RAM, and decrypt only within the live-key request context ([security principles](../../security/security-design-principles.md)). |
| Ghostfolio's queue-based snapshot computation or Finlynq's cron scheduler. | It assumes infrastructure Moni intentionally does not have today; introducing it to copy a visualization would be speculative. | No background job system is installed; a future `pg-boss` path is documented but not implemented (project architecture, [data model](../../design/data-model.md)). |
| A wide “portfolio” scope: manual trade entry, lots, realized returns, benchmarks, FIRE, ETF X-ray and public sharing. | Those features need independent product decisions, new persistent concepts and a write path; they do not follow from balance snapshots. | Investment trades/securities/holdings are documented as deferred extension points, while v1.0 agents are read-only ([data model](../../design/data-model.md), [security principles](../../security/security-design-principles.md)). |

## Future-facing seams worth preserving

- **Security identity, separate from display identity.** Follow Ghostfolio's
  `(dataSource, symbol)` style of provider-qualified identity where it is useful,
  but do not make a ticker the identity. Moni's future global `securities` row
  can carry provider identifiers/metadata; a user-owned holding/position and its
  encrypted quantity/value must point to it through owner-safe relationships.
  This preserves a stable security across account imports and provider changes.
- **Valuation result, not just value.** A future domain result should be able to
  carry `asOf`, native/reporting currency, provider/source, freshness, missing
  inputs and valuation basis. Finlynq's explicit basis/warning idea is useful
  ([valuation](https://github.com/finlynq/finlynq/blob/1720f33d462ede75fbe68515df99315f48cde957/src/lib/portfolio/valuation.ts)); its fallback calculation is not.
- **Provider interface split by capability.** Preserve independent quote,
  historical-price, FX, security-profile and health capabilities rather than one
  provider-shaped blob. Ghostfolio proves the operational utility of this split;
  Moni should use one provider initially, cache only public reference data, and
  record source/date rather than send encrypted user holdings to a provider.
- **Snapshot quality survives aggregation.** Retain an explicit quality marker
  for gaps/partial coverage and pass it to chart/table consumers. This supports a
  value history later without silently joining non-comparable points.
- **No persistence decision yet.** The existing future `entry_trades`,
  `securities` and daily `holdings` extension points are enough to keep the
  eventual investment module possible. Do not add them merely to implement the
  1.1 reference patterns.

## Scope boundary

This research deliberately does **not** choose cards, labels, route names,
charts, columns, refresh intervals, providers or an investment schema. Those
are design and delivery decisions for the owning 1.1 work item. The conclusion
is narrower: Moni can safely borrow the references' legible hierarchy,
drill-down and quality signalling only when every resulting read is based on
Moni's encrypted, RLS-protected snapshot/domain model.
