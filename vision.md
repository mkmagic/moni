# Moni’s Vision
Moni is a self-hosted personal finance app that covers the entire spectrum of managing your finances - from budgeting, tracking income and expenses, managing accounts, investments, and insurances. It is AI-native from the grounds up, providing MCPs that allow agents to interact with the data and to answer user’s queries. It is cross-currency, and extendible by design to support different integrations and data sources. It has built-it intelligence - suggestions on how to save money, how much can be invested, and can understand the user’s financial philosophy. 
Moni is built first and foremost for Israeli citizens, but supports dual-citizenship users, mainly those with US bank / investment account accounts.

**Deployment model**: Moni is self-hosted by a single technical owner (the person who runs the server), but is multi-user — family members get their own accounts and use the app without touching any infrastructure. "Simple setup" therefore means *simple account onboarding for a non-technical family member*, not simple ops. Cross-user data isolation is a hard requirement (see `docs/security/threat-model.md`).
## Design Principles
- Smart DB Design and Security from day 1. 
- AI-native, read-first. In v1.0 agents can **only read** — there is no write path exposed to AI at all. A future version may add a propose-and-confirm mechanism (agents generate previews, users confirm before anything is written). All access — human or agent — goes through a single domain/service layer that governs the DB; there is no second write path.
- Generic interfaces around integrations and data sources.
- Background jobs for anything long-running or scheduled (bank scrapes, market-data fetches, snapshot/statistics computation). Queue + worker running outside the request cycle, with shared rate-limit and cache state held outside the app process. This is what Finlynq lacks; it is *not* a mandate for horizontal scale or a distributed multi-instance deployment.
-  Simple and clear design that assists users in day-to-day financial planning, but backed by a powerful long-term investment and savings engine that allows for strategizing and finding trends.
- Unit & system tests from the start; a consistent coding style enforced by linters.
- Documentation that lives in the repository for agentic coding & development.
## Sources of Inspiration
All sources of inspiration can be found under @repos_eval/
### Finlynq - main source of inspiration
Finlynq is an open-source personal finance app with a built-in MCP server — the closest existing project to Moni. We treat it as a reference implementation, not a starting point: we copy the pieces it got right and rebuild the foundation it got wrong.

**Take from it**:
- Envelope encryption — per-user data keys, encrypted fields, and a working key-rotation path. Solved, hard to get right, portable as-is.
- API-key auth for agents — lets a headless AI agent read your data without a browser session, without the key itself being able to decrypt anything if stolen. This is the mechanism that makes Moni AI-native.
- The multi-currency model — every transaction records what you entered, what the account holds, and what it’s worth in your reporting currency, locked at the rate on that date.
- The import-connector interface — a clean plug-in shape for adding new data sources.
- Security headers and CSP setup — small, correct, no reason to redo.

**Do differently**:
- Exact decimal money, from the first migration. Finlynq stores amounts as floating point and its own code documents the rounding errors that leak into balances. Non-negotiable for Moni.
- One write path. Finlynq’s UI and its AI interface write to the database separately, kept in sync by fragile text-matching checks. Moni gets a single service layer that both go through, so agent writes can’t skip the rules.
- No state trapped in one process. Finlynq can only ever run as a single instance. Moni won’t have that ceiling.
- Documentation that lives in the repo. Finlynq keeps its architecture notes private. A codebase meant to be extended by AI agents has to explain itself to them.

**Add**: insurance tracking, more than one bank-aggregation provider, and the polished UI Finlynq doesn’t have.
### Maybe - A dead project but an inspiration for the domain model
Maybe is a full-scope personal finance app that is no longer maintained.
Take from it:
- The unified ledger shape. One Entry table holds date/name/amount/currency/account; a subtype delegate makes it a spending transaction, a security trade, or a manual balance snapshot. This is how you get expenses and investments onto one timeline instead of building two apps. Most portable idea in the whole evaluation.
- Attribute locking. Every auto-fillable field records whether a human set it. Bank feeds, rules, and AI enrichment skip locked fields, and each change is logged with its source. Without this, auto-categorization silently overwrites the user’s corrections forever. Non-obvious, and Moni needs it on day one.
- AI tools whose schemas are built from the user’s own data — the account/category/merchant filters are enums populated per-request from that user’s actual records, so the model physically cannot invent a category name. Paired with deliberately small page sizes to force the AI to filter rather than dump. Best AI-tool design in the set.
- Account subtyping: checking, credit card, loan, investment, crypto, property, vehicle, other asset, other liability — a ready-made taxonomy.
- Rules engine with conditions and actions, capped at one level of nesting on purpose to stay comprehensible.
### Ghostfolio - for how Moni’s treats investments
Ghostfolio is a mature open-source portfolio tracker — five and a half years old, 691 releases, actively shipped (latest: yesterday). It is not a personal finance app: it has no expenses, no categorization, no budgets, no bank connections, and no insurance. Of the eight domains Moni covers, it covers one. So we mine it for the investment module specifically, not as a template.

**Take from it:**
- Investment return math. Time-weighted, money-weighted, and return-on-average-investment calculations, refined over five years and covered by 23 of the project’s 31 test files. This is the hardest correctness problem in the investment domain and the one thing Ghostfolio has demonstrably earned. Do not reinvent it.
- The market-data provider interface. One small interface, eleven live implementations (Yahoo, CoinGecko, Alpha Vantage, and others), with each provider declaring which symbols it can handle. The cleanest extensibility pattern across all repos reviewed.
- Background job architecture. Price fetching, portfolio snapshots, and statistics all run as queued jobs with shared cache and rate-limiting state held outside the app process. This is exactly the design Moni needs and exactly what Finlynq lacks.
- Exact-decimal arithmetic in the calculation layer — the right instinct, worth carrying further than they did.
- Read-only portfolio sharing — granting someone scoped, revocable view access. A good feature idea for later.

**Don’t take:**
- The frontend. Angular, incompatible with Moni’s stack. Ignore entirely.
- The security model. No encryption of stored data at all, and a single simple API key per user. Materially weaker than what Moni requires.
- The AI integration. Despite appearances, it is one canned prompt: it dumps your holdings into a table and asks a model to comment. No agent access, no tooling, nothing structural. Moni’s AI approach comes from elsewhere.
- Floating-point storage, same flaw as Finlynq — they compute precisely and then save imprecisely.
### Securo - The AI-Agents model that Moni adopts
A self-hosted, privacy-positioned finance manager with the most mature agent surface in the set.
Take from it — this is the important one:
- Agents can read, but they cannot write. They can only propose. Of 30 MCP tools, 21 are reads and 9 are propose_* tools that generate a preview for the user to confirm. There is no direct-write tool at all. This is the answer to “how do I let AI agents act on my financial data without them silently ruining it,” and it’s the single most valuable pattern across all seven repositories.
- Tenancy is part of the tool calling convention. Every tool receives a call context carrying user and workspace identity — it isn’t left to each tool to remember to filter. 
- The agent runtime authenticates to its own tool server with short-lived per-call tokens, and external clients (Claude Desktop, n8n) are tagged distinctly while getting identical authorization.
- Domain details the others miss: credit card billing cycles, installment purchases, transaction splits, shared-expense groups with settlements, savings goals, per-agent knowledge base.
- Passkeys, TOTP with brute-force protection, and OIDC already wired.

Skip: Encryption is applied only to stored provider API keys, not to financial data.
### Where Moni Differs
- Encryption of financial data at rest. Finlynq’s per-user envelope encryption remains the only real reference. Moni’s security bar is above the entire open-source field, so this must be designed, not borrowed.
- Insurance. Zero of seven repositories model it in any form. No schema, no vocabulary, no prior art. Budget real design time for it.
- Genuinely automatic categorization. Every inspiration uses deterministic user-authored rules. None categorize with a model by default. 
# Data Sources & Integrations
All data sources will have a generic interface, which will allow for future support of financial institutions.
## Israeli Bank Scrapers
Expenses, income, saving accounts and balances will be sourced using 
https://github.com/eshaham/israeli-bank-scrapers/ which this project depends on.
## US Banking & Brokers
Investment accounts like Schwab & IBKR have APIs that Moni will implement connectors for.
## Insurances
Insurers in Israel usually don’t provide a public API. Moni will support uploading insurance policies and to connect recurring expenses to specific policies.
## Subscriptions
Subscriptions will be categorized and sourced from expenses, and the user will be able to verify the subscription and further detail their subscription plan they purchased.
## API & MCP
All data will reside behind a domain layer that will provide both an API and an MCP that can be consumed by agents. Moni ships with a built in chat assistant that can reason about the user’s data, and an optional Telegram bot the user can query. 
# User Interface
- Colors and font: inspired by finlynq (check its license before copying any asset verbatim). The background can be a very dark blue instead of black.
- The main view will be an overview dashboard, similar to finylnq. 
- We will design all screen and views together.
# Key Features
## Simple Initial Setup
Setting up an account on Moni should be easy enough for non-technical users. The setup should query the user about their accounts & integrations that they want to connect to the app. Security should be non-compromising during this stage - no passwords or token should ever leak between users or saved un-encrypted.
## Income & Expenses Tracking
The main first feature the Moni will ship. 
- Users will be able to track income & expenses on a monthly / yearly basis.
- Categorization is **deterministic-first, model-as-fallback**. User-authored and built-in rules run first and handle the bulk of transactions cheaply and reproducibly; only the unmatched tail is sent to a model, and the model's result is cached and frozen against the transaction so the same input never re-categorizes differently. Every auto-fillable field carries **attribute-locking** (from Maybe): once a human sets or corrects a category, rules and the model skip that field forever, and each change is logged with its source. The user can add categories, define rules, and override any assignment.
- The model backend is **user-configurable**. Because Moni is self-hosted and privacy-positioned, the user chooses the provider and supplies their own credentials — a hosted API key (Anthropic, Google Gemini) or a local model (e.g. Ollama) for users who don't want transaction data leaving the box. Note: consumer *subscriptions* (Claude Pro, Gemini Advanced) do **not** grant programmatic/API access — those are for the chat UIs only. Programmatic use requires an API key: Anthropic's API is pay-as-you-go; Google's Gemini API (via AI Studio) has a free tier; local models are free but need hardware. Moni must degrade gracefully when no model backend is configured (rules-only mode).
- Moni will automatically recognize subscriptions and will allow the user to monitor recurring expenses in a designated view.
- Graphs will show income, expenses, gain/loss in comparison with previous months. 
- Statistics will be presented to a user in a designated view.
## Budgeting
Budgeting relies on the existing income & expense framework.
- The user will be able to set a monthly budget and assign ceilings for each category. 
- Insights & graphs will be provided to the user during the month, and after, and how he performed financially based on his budget.
## Investments & Savings
Tracking saving & investments accounts, as well as recurring deposits into investment accounts is a key feature of Moni. The user should be able to see where is money is going, and to project his ROI of his current investment strategy. See the chapter on Ghostfolio for inspiration.
## Insurances
While not a first-to-ship feature, the user’s insurance policies can be derived from his expenses, and he should be able to upload documents or describe the type of policy he is holdings.
## AI Chat
An AI Chat assistant that utilizes the built-in MCP servers that Moni ships will be available to the user to query about his finances. Crucially, the Chat Agent is **read-only in v1.0** — it has no write access of any kind. A future version may add the propose-and-confirm write mechanism described in the Design Principles.
## AI Insights
An integral part of every component of Moni. Insights will be created by specialized agents that have different skills to match their domain. What exactly will trigger each agent is TBD, but the goal is to show the user:
- Insights on his budgeting and saving strategies.
- Duplications in subscriptions or anomalies in his spending that he wasn’t aware of.
- Whether his emergency plan fits with his spending habits.
# Version 1.0
Moni is a large product. v1.0 deliberately ships a thin, correct spine and defers everything that isn't load-bearing for it. The goal of v1.0 is: *a family can connect their Israeli accounts, see a categorized, multi-currency picture of their income and expenses, and ask an AI about it — safely and with correct money math.*

## In scope for v1.0
- **Accounts & the unified ledger.** The single Entry-table ledger shape (from Maybe) with account subtyping. Exact decimal money (Postgres `NUMERIC`) and the multi-currency model (entered / account / reporting currency, rate locked at transaction date) from the first migration.
- **One Israeli bank-aggregation source** via `israeli-bank-scrapers`, behind the generic connector interface. Multiple providers and US brokers are deferred.
- **Income & expense tracking** with deterministic-first, model-fallback categorization and attribute-locking. Subscription/recurring detection.
- **The overview dashboard** and the income/expense/statistics views with month-over-month graphs.
- **Security foundation**: per-user envelope encryption of sensitive fields, Postgres Row-Level Security for cross-user isolation, and the credential-custody model in `docs/security/threat-model.md` (encrypted-at-rest bank credentials, user-triggered decryption for sync, recovery codes).
- **The read-only domain layer, API, and MCP.** The built-in AI chat assistant, read-only.

## Explicitly NOT in v1.0
- **Budgeting** — depends on the income/expense framework being mature; ships next.
- **Investments & savings** (the Ghostfolio-derived module) — highest correctness cost, deferred to a dedicated version.
- **Insurance** — no prior art, most design uncertainty, lowest immediate value. Deferred entirely; revisited after the core is stable.
- **US banking & brokers** (Schwab, IBKR).
- **The Telegram bot.**
- **Any AI write path** — no propose-and-confirm mechanism; agents are strictly read-only.
- **Horizontal scale / multi-instance deployment.**
# Tech Stack
The stack optimizes for two things: (1) being fluent to modern AI coding agents, and (2) a native fit with `israeli-bank-scrapers`, which is an npm/Node library. Both point at the TypeScript/Node ecosystem, so Moni is **TypeScript end-to-end**.

Finlynq's stack is a good starting point and we adopt most of it, with two deliberate departures. Finlynq is: **Next.js (App Router) + React + TypeScript**, **PostgreSQL + Drizzle ORM**, the official **`@modelcontextprotocol/sdk`** for its MCP server, **Tailwind CSS + shadcn/ui** (with Recharts for charts), **Zod** for validation, and **jose / bcryptjs / otpauth** for auth and TOTP. Playwright for e2e. It ships as a Docker Compose deployment. This is a sound, boring, well-supported stack that AI agents know cold.

**Adopt from Finlynq's stack:**
- **TypeScript + Next.js (App Router)** as the full-stack framework — a single monolith is right for a self-hosted, single-family app.
- **PostgreSQL + Drizzle ORM.** Postgres is non-negotiable for two independent reasons: `NUMERIC` gives us exact-decimal money, and **Row-Level Security gives us the cross-user isolation guarantee** at the database layer rather than trusting every query to filter correctly.
- **`@modelcontextprotocol/sdk`** — MCP is TypeScript-first; this is the native path.
- **Tailwind + shadcn/ui + Recharts**, **Zod**, **jose/bcryptjs/otpauth**, **Playwright**, and **Docker Compose** for the self-host deployment.

**Depart from Finlynq's stack:**
- **Money type.** Store money as Postgres `NUMERIC` (Drizzle maps it to `string` to preserve precision) and do arithmetic with a decimal library (e.g. `decimal.js` / `dinero.js`) — never JS floats. This is the single most important correction over Finlynq.
- **Add a real background-job runner.** Finlynq's single-process ceiling comes from having no worker tier. Moni needs a queue + worker for bank scrapes and market-data fetches (and later portfolio snapshots). Prefer **`pg-boss`** (Postgres-backed — no extra infrastructure to run for a self-hoster) over BullMQ+Redis unless we later need Redis for other reasons. Rate-limit and cache state for scrapers/providers lives here, outside the request cycle.

**Add (not in Finlynq):**
- Envelope encryption for financial-credential fields and a key-custody flow that a background scrape can use — see `docs/security/threat-model.md` for the design.