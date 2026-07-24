# Moni — Coding Conventions
Load-when-coding conventions. The always-in-context **Non-Negotiable Invariants** live in `AGENTS.md`; this doc is the fuller "how we write code here" and should be loaded when actually writing or reviewing code.

## Decided
### Validation
- **Zod at every trust boundary** — API input, MCP tool arguments, scraper output, and LLM output. Parse, don't assume. A value that hasn't been through a schema at the boundary is untrusted.
### Money
- Money is Postgres `NUMERIC`, mapped by Drizzle to `string`. Never a JS `number`/float for a monetary value, not even transiently.
- Arithmetic goes through the decimal library — never native `+`/`*` on money.
- **Formatting for display happens at the edge (UI/serialization), never in the domain layer.** The domain layer deals in exact values.
### Currency
- Every monetary entry stores two amount legs — **entered** amount/currency and **account** amount/currency — plus the **FX rate and the rate's date**, locked at the transaction date. The **reporting** leg is not a stored amount; it is derived.
- The reporting-currency amount is **derived on read** (`entered × locked fxRate`), not stored. Because the *rate* is locked at the transaction date, the derived value is stable across reads. See `money-and-currency.md` §2 and `data-model.md` §4.3.
### Errors & failure
- **Scrapes fail atomically.** Never partial-write a balance or a set of transactions. A failed/broken scrape surfaces to the user; it does not silently corrupt stored data.
- Surface breakage — don't swallow errors to make a flow "succeed."
### Untrusted input to models
- Ingested strings (transaction descriptions, merchant/counterparty names, memos) are **untrusted model input**. Pass them inside clearly tagged data fields — **never concatenated into the instruction portion** of a prompt.
- **Model output is untrusted too** — sanitize/defang links and markup before showing it to the user.
### Migrations
- Any sensitive column (amounts, descriptions, account numbers, holdings, credentials) ships **encrypted from its first migration**. No "add plaintext now, encrypt later" step ever exists.

### Linting & formatting
- **ESLint** (flat config, `eslint.config.mjs`): `eslint-config-next`'s `core-web-vitals` + `typescript` rule sets, imported directly as native flat-config arrays (not via `FlatCompat`), plus `eslint-config-prettier` to defer all formatting to Prettier. Run via `npm run lint`.
- **Prettier** (`.prettierrc.json`) owns all formatting; `.prettierignore` excludes generated/vendored content (`drizzle/*.sql`, `repos_eval/`, `.next/`, lockfiles). Run via `npm run format` / `npm run format:check`.
- `npm run typecheck` (`tsc --noEmit`) is a required gate alongside lint/format — strict mode is on.

### File / module / directory layout
- `src/db/schema/*.ts` — one Drizzle table-definition file per domain area (identity, connectors, accounts, ledger, classification, dashboard, reference), re-exported from `src/db/schema/index.ts`. `src/db/schema/shared.ts` holds cross-cutting helpers (`bytea` custom type, `timestamps` column pair) — not itself a schema file.
- `src/lib/<area>/index.ts` — small, focused modules (`crypto`, `money`, `validation`); split into multiple files under the same directory once a module grows past one clear concern (e.g. `src/lib/crypto/{aad,aead,dev-key-provider}.ts`), always re-exported from that area's `index.ts`.
- `src/domain/` — the future single access-path layer; currently just the seam (`withUser()` lives in `src/db/client.ts` until the domain layer is designed).
- `scripts/` — standalone `tsx`-run scripts (`seed-demo.ts`); not part of the app bundle.
- `drizzle/` — migrations only: `NNNN_description.sql` (drizzle-kit generated for schema, hand-authored for roles/RLS/triggers) + `meta/` (drizzle-kit's own bookkeeping, never hand-edited).

### Naming
- Files: kebab-case (`dev-key-provider.ts`).
- DB columns: snake_case in Postgres, camelCase in Drizzle TS (Drizzle's `column("snake_case_name")` mapping) — always pass the explicit snake_case string to the column builder, don't rely on inference.
- Types/interfaces: PascalCase (`Money`, `AadContext`); functions/variables: camelCase.
- Drizzle table constants: camelCase matching the table's plural noun (`entries`, `entryTransactions`).

### Drizzle idioms
- Composite tenant FKs use the table-level `foreignKey({ columns, foreignColumns })` builder, never a column-level `.references()` (which only supports single-column FKs) — see any parent->child edge in `src/db/schema/*.ts` for the pattern.
- Every user-owned table gets `unique(table.ownerId, table.id)` even when nothing yet references it compositely, so future children can.
- Hand-authored SQL (roles, RLS policies, triggers) lives in its own `drizzle/NNNN_*.sql`, created via `drizzle-kit generate --custom` so it's tracked in the same migration journal and applied in the same transaction as generated schema changes.
- All DB access goes through `src/db/client.ts`'s `withUser(userId, fn)` — it wraps a transaction and sets `app.user_id` via `set_config(..., true)` before `fn` runs. Never query the pool directly outside this helper except in test/seed fixture setup that intentionally needs to bypass RLS (see the db-schema skill).

### Test organization
- `tests/db/**/*.test.ts` (vitest) — one file per concern (`rls-isolation`, `composite-fk`, `crypto`, `money`, `constraints`, `migrations`), not per schema file. `tests/db/helpers.ts` holds shared fixture/cleanup utilities; `tests/db/setup-test-db.ts` bootstraps the isolated `moni_test` database so the suite never touches the seeded dev `moni` database.
- Fixture setup that must span multiple owners (or bypass RLS for structural checks) uses the elevated/superuser connection; anything meant to exercise the real app access pattern uses `withUser()`.
- Unit tests for pure modules (`lib/crypto`, `lib/money`) that don't need a DB can live alongside `tests/db/` today; split into a separate `tests/unit/` only once that split earns its keep (avoid a premature directory).

### Import ordering
Not yet lint-enforced (no `eslint-plugin-import`/`simple-import-sort` installed). Existing code follows: external packages, then `@/*` internal aliases, then relative imports — enforce this by convention until a real ordering conflict motivates adding the lint rule.
