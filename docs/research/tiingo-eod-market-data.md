# Tiingo EOD market-data findings

Research date: 2026-07-31. Scope: a best-effort daily current-value estimate for
active USD ETFs and common stocks, initially VTI, VXUS, and AAPL.

## Finding

Tiingo's end-of-day feed satisfies the narrow technical contract. Its supported
ticker inventory identifies symbol, exchange, asset type, price currency, and active
date range. The latest-price endpoint returns source-dated CSV closes, so Moni can
parse money as exact decimal text. Tiingo documents end-of-day availability around
5:30 p.m. Eastern with possible corrections through 8 p.m.; this is appropriate for
a daily estimate, not a real-time price.

The local POC (`npm run poc:tiingo-eod`) proved current inventory coverage, expected
ETF/stock classification, USD currency, one latest row per symbol, exact positive
decimal closes, ISO source dates, and no-more-than-seven-day freshness for VTI,
VXUS, and AAPL. It printed or persisted no token, URL, price, holding quantity,
symbol metadata, or raw provider response. This sample does not prove every security
or corporate-action edge.

## Product boundary

- Use Tiingo only for the current estimate; broker/statement observations remain the
  historical and reconciliation evidence.
- Keep quote refresh best-effort and independent of atomic investment-source
  promotion. Fall back visibly to the broker value when a quote is unusable.
- Use one instance-wide token for the current single-user deployment. Tiingo's
  self-service terms describe internal use and its developer exemption assumes
  distinct user tokens. Written provider permission is therefore required before
  one token serves multiple users.

## Primary sources

- [End-of-day API](https://www.tiingo.com/documentation/end-of-day)
- [Authentication and connecting](https://www.tiingo.com/documentation/general/connecting)
- [General API guidance and developer licensing](https://www.tiingo.com/documentation/general)
- [Pricing and request limits](https://www.tiingo.com/about/pricing)
- [Ticker symbology](https://www.tiingo.com/documentation/appendix/symbology)
- [Current supported-ticker inventory](https://apimedia.tiingo.com/docs/tiingo/daily/supported_tickers.zip)
