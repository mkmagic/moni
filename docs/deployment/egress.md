# Worker egress policy

Deployment networking must enforce these process-specific allowlists in addition to
the application's exact-origin and redirect checks. Every listed worker also needs
its configured PostgreSQL endpoint; no listed application allowlist substitutes for
this network control.

| Process | Permitted egress |
| --- | --- |
| `scripts/ibkr-worker.mts` | `https://ndcdyn.interactivebrokers.com` (the Flex service) and PostgreSQL |
| `scripts/schwab-import-worker.mts` | PostgreSQL only; no internet egress |
| `scripts/boi-worker.mts` | `https://edge.boi.gov.il` (the BOI SDMX endpoint) and PostgreSQL |
| `scripts/tiingo-quote-worker.mts` | `https://api.tiingo.com` and PostgreSQL; this process receives no broker credentials |

The sync route starts bounded child processes directly. There is no queue, scheduler,
or unattended worker to allow. Retain the five-minute child timeout and lazy
on-read repair of orphaned `running` syncs when applying the policy.
