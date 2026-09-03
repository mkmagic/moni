<div align="center">

<img src="public/moni-icon.png" alt="Moni" width="140" />

# Moni

**Self-hosted personal finance that bridges Israeli banks and international assets.**

[![CI](https://github.com/mkmagic/moni/actions/workflows/ci.yml/badge.svg)](https://github.com/mkmagic/moni/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A526-339933.svg?logo=node.js&logoColor=white)](.nvmrc)
[![Built with Next.js](https://img.shields.io/badge/Next.js-TypeScript-black.svg?logo=next.js)](https://nextjs.org)

</div>

---

## Overview

Moni covers the whole picture of your money — income and expenses, accounts, budgeting,
investments and savings — for people who bank in Israel but also hold assets abroad. It reads
your Israeli bank and card activity, keeps every figure in exact-decimal money across currencies,
and lets you ask an AI about any of it.

It is **self-hosted by one technical owner** — the person who runs the server — but **multi-user**:
family members each get their own account and use the app without touching any infrastructure.
Complete isolation between users is a hard requirement, enforced at the database, not left to
application code to remember.

> **Status:** under active development. A family can already connect their Israeli accounts,
> see a categorized, multi-currency picture of income and expenses, set budgets, track
> investments and long-term savings, and ask an AI about it — with correct money math.

## Running it at home

Moni is a single Next.js app plus a PostgreSQL database. To stand it up you need:

- **Node ≥ 26** (see [`.nvmrc`](.nvmrc))
- **PostgreSQL 16** — a `docker-compose.yml` is included for local use; any Postgres 16 works
- **A passkey-capable browser/device** — bank credentials can only be unlocked by a WebAuthn passkey (see below)

```bash
# 1. Install dependencies
npm ci

# 2. Configure — copy the example and fill in real values
cp .env.example .env

# 3. Start Postgres (or point .env at your own)
docker compose up -d

# 4. Run migrations
#    First run only bootstraps the DB roles as the Postgres superuser — the
#    exact one-time value for DATABASE_URL_MIGRATE is documented in .env.example.
npm run db:migrate

# 5. Start the app
npm run dev
```

**You do not need an LLM to run Moni.** Categorization is deterministic-first: built-in and
user-authored rules handle transactions with no model at all, and the app runs fully in this
rules-only mode. An LLM only powers the optional extras — smart categorization of the unmatched
tail, and the AI chat.

If the owner wants those features, **the owner supplies a single API key when deploying**
(`MONI_LLM_API_KEY`, with optional `MONI_LLM_BASE_URL` / `MONI_LLM_MODEL` — pointing at a hosted
provider or a local model on the box). This is a host-level setting: **individual family members
cannot supply their own AI credentials** — either the owner configures one backend for the whole
instance, or there are no AI features.

## Security & authentication

Security in Moni is **tiered** on purpose — the bar is deliberately high on the crown jewels and
relaxed elsewhere, so effort goes where it matters.

- **Tier 0 — bank/broker credentials, encryption keys, recovery codes.** These must be
  unrecoverable from a stolen disk, database, or backup. Moni uses **two separate keys**: your
  login password unlocks a **data key** for your financial data, while your **bank credentials can
  only be unlocked by a WebAuthn passkey** — the password can never open them. Tier-0 material is
  held as wipeable binary and zeroed right after use; keys live in RAM only, never on disk or in
  logs.
- **Tier 1 — cross-user isolation.** One family member must _never_ see another's data. This is
  the single most important invariant, enforced with PostgreSQL **Row-Level Security** at the
  database layer, not by trusting each query to filter correctly. Sensitive fields (amounts,
  descriptions, account numbers, holdings) are **encrypted before they are ever written**, with a
  key the database never sees.
- **Everything else — relaxed.** Effort is spent on the two tiers above rather than spread evenly.

One honest caveat: the running server sees your financial data in plaintext at processing time —
server-side scraping makes that unavoidable. Moni does **not** claim the owner cannot see your data.

## Data sources

- **Israeli banks & cards** — sourced through
  [**`israeli-bank-scrapers`**](https://github.com/eshaham/israeli-bank-scrapers), the open-source
  library Moni depends on for Israeli financial institutions. Full credit to that project.
- **Brokerages** — Interactive Brokers via its **Flex Query** API, and **SnapTrade** for other
  brokers.
- **Long-term savings** — Israeli pension, קרן השתלמות and קופת גמל reports, parsed from provider
  documents.

All sources sit behind one generic connector interface, so new institutions plug in the same way.

## AI-native, read-only

Moni ships with a built-in [MCP](https://modelcontextprotocol.io) server so agents can reason about
your data. In **v1.0 the AI is strictly read-only** — there is no write path of any kind. Every
access, human or agent, goes through a single domain/service layer; there is no second way into the
database. AI reads are opt-in per user and scoped to that user's own data.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint .
npm run format:check
npm run test        # Vitest — requires a live Postgres
```

All four gates plus `npm run build` run in [CI](.github/workflows/ci.yml) on every pull request.
The test suite bootstraps an isolated `moni_test` database, so every test — unit tests included —
needs a running Postgres.

## License

Moni is licensed under the **[GNU Affero General Public License v3.0](LICENSE)**. If you run a
modified version as a network service, the AGPL requires you to make your source available to its
users.

## Acknowledgements

Built on the shoulders of [`israeli-bank-scrapers`](https://github.com/eshaham/israeli-bank-scrapers),
and shaped by studying the open-source finance projects that came before it — Finlynq, Ghostfolio,
Maybe, and Securo.
