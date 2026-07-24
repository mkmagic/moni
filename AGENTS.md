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
- **Background Jobs:** `pg-boss` (Postgres-backed queue/worker) for long-running tasks like bank scraping.
- **Testing & Tooling:** Playwright, Zod, jose/bcryptjs/otpauth.
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
- **Product goals, roadmap, v1.0 scope** — @vision.md
- **Security rules to follow** — @docs/security/security-design-principles.md
- **Security reasoning (load only when a decision seems to conflict with the rules)** — @docs/security/threat-model.md
- **Data model & the unified ledger** — @docs/design/data-model.md
- **Domain/service layer & RLS wiring (the single access path)** — @docs/design/domain-layer.md
- **Money & multi-currency handling** — @docs/design/money-and-currency.md
- **Data-source connector interface** — @docs/design/connector-interface.md
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
## 3\. Surgical Changes
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
## 4\. Goal-Driven Execution
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

----

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.