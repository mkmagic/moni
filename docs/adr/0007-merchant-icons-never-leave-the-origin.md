# Merchant icons never leave the origin

`merchants.logo_url` is a plaintext URL column, and the obvious way to fill it is
the cheap way: point it at a logo service or the merchant's own favicon and let
the browser fetch it. **We will not do that.** Catalog merchants get SVGs
bundled in the repo and served from Moni's own origin; every other merchant gets
a monogram chip tinted with its category colour. When the external lookup (#12)
ships and returns a logo, Moni fetches it **server-side once**, stores the bytes,
and serves them locally. A remote URL never reaches a browser.

The reason is that a logo request is a disclosure, and this particular one is
uncommonly bad. Rendering the recurring view with remote logos makes the user's
browser announce, to whoever hosts them, the list of merchants that user pays —
with their IP address and a referer, on every page view, for every user of the
deployment.

## How this differs from the egress ADR 0003 already permits

ADR 0003 allows a *merchant* match text to be sent to an external
categorization source. That is a **server-side** call, one per distinct
merchant string for all time, carrying no sum and no timeline, under a
pseudonym the user controls — and it is per-user opt-in and off by default.
Browser-fetched logos invert every one of those properties: they are
client-side, per-render rather than per-merchant, they carry the user's own IP,
and nobody opted into them.

An encrypted `merchants.name_ct` protecting the stored copy would be no defence
whatever, for the same reason ADR 0003 gives: encryption protects a database
dump and does nothing about egress.

## Consequences

- **We carry the icon set.** A curated handful of SVGs for the shipped catalog
  (Netflix, Spotify, Cellcom, Partner, Bezeq, HOT, and friends) lives in the
  repo. Trademarks belong to their owners; the icons are used to identify the
  payee, which is the identical use every finance app makes of them.
- **`logo_url` holds a local path**, e.g. `/merchants/netflix.svg` — not an
  absolute URL to anywhere. Any code that would set it to an external origin is
  a bug, not a shortcut.
- **Unknown merchants are never icon-less**, they are monogrammed. The fallback
  covers 100% of rows, so catalog coverage is a polish dial and never a
  correctness problem.
- **#12 inherits an obligation.** If external lookup returns a logo, the fetch
  and the storage are #12's to build; until then the catalog and the monogram
  are the whole story. This is deliberately recorded before #12 starts, so the
  cheap path is closed while it is still cheap to close.
- **The view works with no network at all.** Which is the ordinary condition of
  a self-hosted app on a home LAN, and worth having by construction rather than
  by luck.
