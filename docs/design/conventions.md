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

## Deferred (add when the first real code sets the pattern)
These can't be settled before code exists, and inventing them now would be speculative. Fill each in as the first real code establishes the style:
- File / module / directory layout.
- Naming conventions (files, types, functions, DB columns).
- React component structure and where server/client boundaries fall.
- Drizzle query idioms and where the domain layer wraps them.
- Test file organization and naming; unit vs. e2e split.
- Import ordering / lint-enforced style.
