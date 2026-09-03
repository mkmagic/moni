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

> **Status:** pre-1.0, under active development. **v1.0** ships a thin, correct spine: a family
> connects their Israeli accounts, sees a categorized, multi-currency picture of income and
> expenses, and asks an AI about it — safely, with correct money math. Budgeting, investments,
> insurance and US brokers are designed but deferred past v1.0.

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

A model backend is **optional**: Moni runs fully in rules-only mode with no AI provider
configured. If you want AI features, you supply your own credentials — a hosted API key
(Anthropic, Google Gemini) or a local model (e.g. Ollama) so transaction data never leaves the box.

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
- **US banks & brokers** (Schwab, IBKR) and **insurance** — designed as future connectors behind a
  generic data-source interface; not in v1.0.

## AI-native, read-only

Moni ships with a built-in [MCP](https://modelcontextprotocol.io) server so agents can reason about
your data. In **v1.0 the AI is strictly read-only** — there is no write path of any kind. Every
access, human or agent, goes through a single domain/service layer; there is no second way into the
database. AI reads are opt-in per user and scoped to that user's own data.

## Tech stack

TypeScript end-to-end: **Next.js (App Router) + React**, **PostgreSQL + Drizzle ORM**,
**Tailwind CSS + shadcn/ui + Recharts**, the official **`@modelcontextprotocol/sdk`** for MCP, and
**Vitest** for tests. Money is stored as Postgres `NUMERIC` and computed with `decimal.js` — never
a floating-point number.

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
