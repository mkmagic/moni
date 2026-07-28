# Moni - Context for AI Agents
## Project Overview
Moni is an AI-native, self-hosted, multi-user personal finance application designed primarily for Israeli citizens. It features budgeting, account tracking, investments, and more. 
Key product requirements:
- **Self-hosted but multi-user:** One technical owner deploys it, but multiple family members use it. Complete cross-user isolation is a non-negotiable requirement.
- **AI-Native:** Includes built-in MCPs for agents to interact with data. In **v1.0, AI agents are strictly read-only**. There is no direct AI write path.
## Tech Stack
Moni is **TypeScript end-to-end**:
- **Framework:** Next.js (App Router) + React
- **Database & ORM:** PostgreSQL + Drizzle ORM
- **UI:** Tailwind CSS + shadcn/ui + Recharts
- **MCP:** `@modelcontextprotocol/sdk`
- **Background Jobs:** none yet. Long-running work (bank scraping) is a fire-and-forget `spawn()` of a `tsx` child process from the API route (`scripts/scrape-worker.mts`); the parent marks the `sync_runs` row `running` and the UI polls it. A Postgres-backed queue (`pg-boss`) is the intended destination but **is not installed** — don't write code that assumes a scheduler exists.
- **Testing & Tooling:** Vitest (tests live under `tests/unit/**` and `tests/db/**`; all tests currently require a live Postgres via `vitest.setup.ts`), Zod, `@node-rs/argon2` + `@noble/ciphers`/`@noble/hashes`. There is **no e2e/browser test layer** — Playwright is not installed.
## Non-Negotiable Invariants
These override “simplicity” — never trade them away without asking.
- **Money is exact-decimal.** Postgres `NUMERIC`, mapped by Drizzle to `string`. Arithmetic via a decimal library. Never a JS `number`/float for money — not even transiently.
- **One access path.** All DB reads/writes go through the domain/service layer. No query bypasses it; there is no second write path.
- **Every user-owned table is RLS-protected** and carries an owner column; the request sets `SET LOCAL app.user_id`. Never rely on a `WHERE user_id = ?` alone.
- **Sensitive fields are encrypted before the first write** (amounts, descriptions, account numbers, holdings, credentials). Keys live in RAM only — never to DB, disk, swap, or logs.
- **Tier-0 secrets are `Buffer`/`Uint8Array`, `fill(0)`-wiped after use** — never `String`.
- **No AI write path in v1.0.** Agents read only.
- **Rules-only mode must work.** The app functions with no model backend configured.
## Core Documentation
Only load a doc when you’re certain you need what it covers.
- **Product goals, roadmap, v1.0 scope** — `vision.md`
- **Security rules to follow** — `docs/security/security-design-principles.md`
- **Security reasoning (load only when a decision seems to conflict with the rules)** — `docs/security/threat-model.md`
- **Data model & the unified ledger** — `docs/design/data-model.md`
- **Domain/service layer & RLS wiring (the single access path)** — `docs/design/domain-layer.md`
- **Money & multi-currency handling** — `docs/design/money-and-currency.md`
- **Data-source connector interface** — `docs/design/connector-interface.md`
## Development Guidelines
### 1\. Think Before Coding
**Don’t assume. Don’t hide confusion. Surface tradeoffs.**
Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what’s confusing. Ask.
### 2\. Simplicity First
**Minimum code that solves the problem. Nothing speculative.**
- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.
Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.
### 3\. Surgical Changes
**Touch only what you must. Clean up only your own mess.**
When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don’t delete it.
When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don’t remove pre-existing dead code unless asked.
The test: Every changed line should trace directly to the user’s request.
### 4\. Goal-Driven Execution
**Define success criteria. Loop until verified.**
Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug” → “Write a test that reproduces it, then make it pass”
- “Refactor X” → “Ensure tests pass before and after”
For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```
Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.
### 5\. Gates
`npm run typecheck && npm run lint && npm run format:check && npm run test` — all four, before reporting work done.
- **`lint` is `eslint .`, never `next lint`.** 
- Read the gate's *exit code*, not just its last line. A tool that never ran is not a tool that passed.
- `format:check` has **no** known-acceptable failures — any failure is real. (`tsconfig.json`, which `next dev` *and* `next build` both rewrite, is prettier-ignored now, as is `graphify-out/`.)
- The same four gates run in CI (`.github/workflows/ci.yml`), plus `npm run build`. `npm test` needs a live Postgres for *every* test, `tests/unit/**` included — `vitest.setup.ts` bootstraps `moni_test` unconditionally.
### 6\. Keep the skills honest
Skills are the project's memory. **If a skill turns out to be out-of-date or misleading more than once in a session, don't just work around it — tell the owner exactly what you'd change and cite the evidence from this session that proved it wrong.** A skill that quietly misleads costs every future session, and you are the only one positioned to notice.

----

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

## Repository Tools
## graphify
This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.
Rules:
- **For broad exploration** — "where does X live", "what calls Y", "how do these relate" — prefer `graphify query "<question>"` over grep when graphify-out/graph.json exists. Also `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- **Not for targeted reads.** When you already know the file just open it. 
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review.
- After modifying **code** (`src/**`, `scripts/**`, `tests/**`, config files), run `graphify update .` to keep the graph current — AST-only, no LLM, no token cost.
- After modifying **only docs** (`*.md`, `docs/**`, `vision.md`, `.agents/skills/**`), do **not** run `graphify update .` unprompted. Doc changes trigger semantic re-extraction, which dispatches LLM subagents and costs real tokens (~240k for this corpus). Ask the owner first.

## Agent skills

### Issue tracker

Issues and PRDs live as GitHub issues in `mkmagic/moni`, driven by the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — `CONTEXT.md` + `docs/adr/` at the repo root, both created lazily. See `docs/agents/domain.md`.
