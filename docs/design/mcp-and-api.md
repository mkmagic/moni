# Moni — MCP & API

> **Status: ✅ Architecture decided.** The key-custody, transport, token, and tool-surface *shape* are fixed below. The concrete tool list, schemas, and constants are implementation work (§7). Supersedes the wayfinder key-custody map (issues #17/#22/#23/#24) — those close pointing here. Requirements input survives from #19 (required query surface) and #20 (protocol/client support).

**Purpose:** the read-only tool surface AI agents consume, how each call is authorized and confined to one user, and how encrypted reads get a key.

**Ships in:** Moni **1.3**, after investments (1.1) and budgeting (1.2) — not v1.0. The surface is designed against 1.3 data (expenses/categories/merchants/recurring from 1.0; positions/cash/valuations/allocations from 1.1; budgets/ceilings from 1.2).

---

## 1. The decision, in one paragraph

A user opts **their own** account into AI access through either a manually minted **per-user agent token** or an interactive **OAuth grant** for a supported MCP client. Both are issuance ceremonies around the same envelope: the presented bearer secret is the only material that can **unwrap that user's data key (DK) for the duration of one request**, after which the domain-layer read finishes and DK is wiped. The server holds **no standing DK or signing key**; between requests it holds only wrapped DK, useless without the presented secret. Both credentials reach **DK only** — the credential key (CK) that decrypts bank logins is structurally unreachable — and authorize **reads only**, confined to **one user** under RLS. The trade the user accepts by opting in is unchanged: a stolen bearer or prompt-injected model can **disclose that user's own financial data** — never move money, write, reach the bank, or cross to another user.

This reverses the earlier draft (threat-model §5.6, previous revision) that refused any agent decryption capability. That draft bought "key theft ⇒ no decrypt, absolutely" at the price of an MCP that only worked while the user was actively using Moni. The product wants an assistant that reasons over finances **while the user is away**. §5.6 (current revision) is the security write-up of this reversal; this document is the design.

---

## 2. Why this shape (and what was rejected)

Killing the local shim forces server-side decryption: SQL cannot aggregate ciphertext, and the model cannot be trusted with Moni's exact-decimal money math. So decryption happens in the app tier, and the only question is *how DK gets there for a headless, possibly-absent user*. Three candidates were live:

| Candidate | What a stolen token yields | Idle-server memory dump | Works when user absent | Verdict |
|---|---|---|---|---|
| **Local shim + second secret** | ciphertext only | — | yes | **Rejected** — ships an extra artifact; the product wants any MCP client to work with no local install. |
| **Persistent server-side warm-key window** | DK (via server) | **every opted-in user's DK** | yes | **Rejected** — widest server-compromise exposure, for no UX gain over per-request. |
| **Token-decrypts-per-request** ✅ | that user's DK | **nothing** (only wrapped DK at rest) | yes | **Adopted.** Same UX as warm-key, strictly smaller exposure. |

Per-request unwrap wins because an idle or between-requests server holds no plaintext key. DK is in RAM only for the milliseconds of an active request, then wiped — the same discipline as every other Tier-0 secret (threat-model §5.5).

---

## 3. The key boundary — DK yes, CK never

This boundary is the reason the trade is acceptable, and it is **enforced in code, not by policy**:

- **DK** wraps Tier-1 financial data (amounts, descriptions, counterparties, holdings). It rides the same path the login password already wraps. The agent token gets a DK-unwrapping capability.
- **CK** wraps Tier-0 bank credentials. It is wrapped **only** by a WebAuthn-PRF passkey; no password- or token-derived KEK can open it (`src/domain/credential-unlock.ts`; the module exists precisely to enforce this). It has no recovery path.
- **An agent request may never arm or read the credential window** (`src/lib/auth/cred-window.ts`). This is a hard rule the MCP layer enforces and a cross-tenant/boundary test asserts.

**Worst case a token yields:** read access to transactions/balances/holdings. **Never:** logging into, moving money at, or impersonating the user at their bank. A phished password (or a leaked token) cannot become a bank compromise — that is the property the two-key model buys, and the token design preserves it.

---

## 4. MCP credentials: static token and OAuth

- **Opaque, revocable, hashed at rest.** A random opaque bearer secret. Server stores only a hash. One row per token — `agent_tokens(user_id, token_hash, wrapped_dk, created_at, expires_at, last_used_at, revoked_at, label)` — RLS-scoped to its user. The `wrapped_dk` column holds DK re-wrapped under a KEK derived from the token secret at mint time.
- **Static tokens remain supported.** For CLI clients and bridges, the `moni_agent_…` secret resolves a hashed `agent_tokens` row and unwraps its DK envelope. Server-side revocation is the primary control; `expires_at` is a backstop.
- **OAuth 2.1 + CIMD is additive.** Claude and ChatGPT discover Moni through RFC 9728/8414 metadata and identify themselves with allowlisted HTTPS Client ID Metadata Documents (CIMD), not Dynamic Client Registration. The authorization-code flow requires a live Moni session and PKCE S256. A 60-second single-use code carries DK from consent to the token endpoint; a rotating refresh envelope lasts 90 days; access tokens last one hour.
- **Stateless access tokens without a server key.** `moni_oauth_at_…` contains the grant UUID, expiry, random secret, and wrapped DK. The expiry is bound into the AEAD AAD, so changing it makes unwrap fail; every request also loads the grant to enforce expiry, revocation, and the user's opt-in. There is no access-token row and no signing key. `moni_oauth_rt_…` is looked up only by a SHA-256 hash and rotates atomically on every refresh.
- **CIMD is SSRF-constrained.** Moni fetches client metadata only from the hard allowlisted `claude.ai` and `chatgpt.com` HTTPS hosts, on the default TLS port, without redirects, with response-size and timeout limits. The document must be self-referential. Redirects must be listed in it and same-origin, except Claude Code's registered `localhost`/`127.0.0.1` loopback callbacks, whose ephemeral ports are ignored per RFC 8252. ChatGPT's transition metadata is accepted only when its supported-methods array includes Moni's public-client `none` method.
- **Minting requires a live password session.** DK is reachable only behind the password today. Minting unwraps DK inside an authenticated web session, re-wraps it under a fresh token-derived KEK, writes the `agent_tokens` row, and returns the token secret to the user **exactly once** (one-time display, like a recovery code). Minting **cannot** happen headlessly — it is the single step that needs the human.
- **Per-user opt-in.** Any user mints a token **for their own account** — it is their DK-disclosure trade. The owner cannot force it on a family member's account; a family member opting in never touches anyone else's DK.
- **The token secret is Tier-0-equivalent and lives outside Moni's trust boundary.** It sits in a client's config — a phone keychain (decent) or a self-hosted agent's config file (plaintext on a box the user controls). Minting one extends Moni's trust to include that client's secret storage. Say so at mint time.

---

## 5. Transport — Streamable HTTP over HTTPS

- **Transport type:** the MCP **Streamable HTTP** transport (client POSTs JSON-RPC; server may stream responses over SSE). Required because the client is remote — the `stdio` transport cannot cross a network. (#20 tracks real-client support.)
- **This is not "plain HTTP."** Transport type (how messages flow) and TLS (wire encryption) are different layers. Moni is HTTPS-only (ADR-0004, `src/proxy.ts` rejects non-TLS requests, HSTS always sent). The MCP endpoint is one more route behind the same terminator: `https://<host>/mcp` (or similar), same cert, same TLS 1.2+.
- **TLS-terminating-proxy caveat.** Because decryption is server-side, DK-decrypted responses are cleartext at the app tier and pass through whatever terminates TLS. On a self-hosted box that terminator is the owner's own — inside the trust boundary. **Do not** put a third-party CDN/proxy that terminates TLS in front of the MCP endpoint; it would see decrypted financials.

---

## 6. The tool surface

Shape fixed by #19; concrete tools deferred to §7. Three layers, built on a **composable query DSL that executes past the decrypt** (server-side aggregation over the user's own data):

1. **Aggregation / query DSL** — the workhorse. Compose filters (date range, account, category, merchant, currency) and reductions (sum, count, group-by-period, group-by-category, top-N) that run **server-side in the domain layer over the entire ledger**, returning computed figures. This is how "find deep patterns across my whole history" is answered — the model gets summaries, not 10k rows.
2. **Authoritative computed tools** — one per figure Moni stands behind (net worth, monthly cash flow, category spend, budget vs. actual, allocation). These reuse the exact domain-layer computations the UI uses, so the AI never reimplements Moni's money semantics. Each carries a **structured provenance block**: freshness, sampling/completeness, and the identity it ran as.
3. **Raw-row escape hatch** — returns individual transactions for genuine drill-downs (one merchant, one month). **High- or un-capped**, per the product decision to grant full-DB read reach. Carries flags plus Moni's own totals so the model can reconcile.

**Design rules the surface obeys:**

- **Full reach, aggregation transport.** The user may grant the agent the entire ledger. But a year of transactions cannot fit a model's context, so raw rows are the wrong default for aggregate questions — the DSL aggregates server-side and hands back results. The escape hatch exists for real row-level needs. The cap on raw rows (if any) is a **context/physics** concern, not a security control — there is no artificial security row cap (threat-model §5.6, §9).
- **Rows safe to sum by construction; money math stays in the domain layer.** Every figure the AI reports traces to an authoritative computed tool or a DSL reduction that ran through `decimal.js` in the domain layer — never model-side arithmetic on decrypted numbers.
- **Tool schemas built per-request from the user's own data** (e.g. the category/merchant enums). Note the merchant enum needs DK to build (#19's finding) — it is constructed inside the request's DK window, not cached in plaintext.
- **Aggregates mandatory for volume.** A tool that could return a year of entries must offer an aggregate form; the raw form is the opt-in drill-down, not the default path.

**One consumer in 1.3:** the external MCP endpoint for third-party clients. The **in-app chat assistant is deferred** (to whenever propose-and-confirm lands — #19), but tool definitions are a shared module so the chat later becomes an adapter, not a rewrite.

---

## 7. Tenancy, confinement, and what stays open

**Tenancy on every call (non-negotiable, threat-model §6):**
- The token resolves to exactly one `user_id`. Every tool invocation sets `SET LOCAL app.user_id` from it and runs under RLS as an RLS-subject role. Tenancy is part of the call context — never left to each tool to remember to filter (pattern from Securo).
- **No cross-user path.** Household questions are answered by two clients composing, never by a Moni-side join. There is no "read everyone" tool.
- **Cross-tenant + boundary test suite** (security-design-principles step 12): user A's token cannot reach B's rows through any tool; no token path can arm/read the credential window or unwrap CK. This reuses `credential-unlock`'s random-bytes test seam so it exercises production code, not a test-only bypass.

**Abuse & injection posture (threat-model §9):**
- Prompt injection via ingested strings is the dominant residual. A standing token gives the model unattended read over the user's own full ledger, so a successful injection can exfiltrate it through the *model's own egress* (not Moni's). This is **disclosure of the token owner's own data** — bounded by read-only + DK-only + single-user; never CK, write, or cross-user.
- Countered by **per-credential volume/rate caps** and an **access audit log** (every static-token or OAuth-grant call: user, tool, argument shape, row count, timestamp — **never plaintext**), which makes an anomalous whole-ledger sweep visible — not by an artificial row cap.
- Tool results are treated as untrusted model input (tagged data/instruction separation), and model output shown to the user is defanged.

**Still open (implementation session decides):**
- The concrete tool list, schemas, and the DSL grammar's exact operators.
- The raw-row context cap constant (physics, not security) and default TTL / rate-limit numbers.
- Token-management UX detail: the list/rotate/revoke screen, `last_used_at` display, and the one-time-secret mint flow.
- The prompt-injection tool-result hardening spec (tagging format, system-prompt boundary text).

---

## 7b. Implementation status (issue #113)

- **Phase 1 — token domain + schema — done.** `agent_tokens` (`src/db/schema/identity.ts`, migrations `0028`/`0029`), RLS-scoped to `owner_id`. `src/domain/agent-token.ts` provides `mintToken` / `verifyAndUnwrapDk` / `revokeToken` / `listTokens`. Token secret is 32 random bytes shown once (prefix `moni_agent_`), stored only as a SHA-256 `token_hash`; `wrapped_dk` re-wraps DK under `deriveKekFromUnlockSecret(secret)` — the same seam `webauthn-prf` uses for CK, so no CK column exists on this surface.
  - **Pre-auth lookup wrinkle (worth knowing before touching `0029`):** verify must find a row *by hash* before `app.user_id` is set, so `agent_tokens` carries a second, SELECT-only policy `agent_tokens_app_select` gated on the GUC being unset (mirrors `users_app_select`, drizzle/0002). Because that gate doesn't constant-fold the tenant qual away, the tenant policy is written with `nullif(current_setting('app.user_id', true), '')::uuid` — the standard bare `''::uuid` cast would *throw* on a pooled connection whose GUC reverted to `''` after a prior `withUser` commit. Still fail-closed (unset/empty ⇒ zero rows), and `listTokens`/`revokeToken` stay tenant-scoped because they run inside `withUser`.
- **Phase 2 — MCP server + auth — done.** `POST /api/mcp` (`src/app/api/mcp/route.ts`), MCP **Streamable HTTP** in stateless JSON mode via `WebStandardStreamableHTTPServerTransport`. `withAgentRequest` (`src/lib/mcp/agent-request.ts`) turns the bearer token into a one-request `{ userId, dataKey }` window and `fill(0)`-wipes DK in a `finally`.
- **Phase 3 — tool surface (starter subset) — done.** `src/lib/mcp/server.ts` registers three read-only tools, each reusing the exact domain computation (no model-side money math) and stamping a provenance block (identity + freshness + completeness):
  - `net_worth` — authoritative computed figure, reuses `getOverview` (`src/domain/dashboard.ts`); freshness = the valuation's own `ValuationMetadata`.
  - `spending` — aggregation workhorse, `src/domain/aggregates.ts` (`aggregateSpending`): group/sum by category or month over the whole ledger, same flow/FX/pending rules as the dashboard, all decimal.js.
  - `transactions` — raw-row escape hatch, reuses `listEntries`; high-capped (`RAW_ROW_CAP`, a physics limit, not a security control).
  - Tool input schemas are built **per request** from the user's own data: the `category`/`merchant` filter enums. The merchant enum is decrypted inside the DK window (the #19 finding). `buildAgentMcpServer` is async for this reason. Account deletion removes `agent_tokens`; `listEntries` gained a `merchantId` filter (mirrors `accountId`) so the merchant enum can resolve name→id.
  - The full DSL grammar is still deferred (§6/§7); the computed tools below landed instead.
- **Phase 6 — the rest of the read-only surface — done.** `src/lib/mcp/server.ts` adds eight more tools, each reusing its exact domain seam (no model-side money math) and stamping the same provenance block: `accounts` (`listAccountsGrouped`), `budget` (`getBudgetMonth`, `month` defaults to current) and `budget_history` (`getBudgetHistory`), `portfolio` (`getPortfolioOverview`, freshness = its `ValuationMetadata`) and its raw drill-down `holdings` (`listPortfolioHoldings`, capped/paginated, plaintext-enum filters only — no DK-built enum needed), `long_term_savings` (`listLongTermSavingsAccounts`), and the structural `categories` (`listCategoryTree`) and `rules` (`listRules`). No new tables. `SERVER_INSTRUCTIONS` names them and tells the model which to prefer. `tests/db/mcp-tools.test.ts` asserts each tool matches its domain layer exactly and stays tenant-scoped. The **query DSL grammar** (operators/filters as data) remains the only deferred item on the surface.
- **Phase 4 — abuse + injection posture — done.** A new owner-scoped `agent_access_log` table (`src/db/schema/identity.ts`, migrations `0030`/`0031`) records one row per tool call: tool, argument *shape* (`{arg: jsType}` — never values, so a category/merchant filter value never lands in the log), and row count. `src/domain/agent-access-log.ts` provides `recordAccess` + `assertUnderRateCap` (counts the log itself over a trailing window — in-process-free, survives restart, consistent across processes; caps `RATE_CAP_PER_MINUTE`/`RATE_CAP_PER_DAY` are generous backstops that trip a runaway sweep, not a security row cap). Both are wired in `buildAgentMcpServer`'s per-tool `guardedTool` envelope: enforce cap → run → audit → tag. Every tool result is now two content blocks — an untrusted-data notice, then the JSON payload — the data/instruction separation for the injection residual (§7). `verifyAndUnwrapDk` returns the `tokenId` so calls attribute to one token; `AgentRequestContext` carries it.
- **Phase 5 — token-management UI + opt-in — done.** Per-user opt-in is `users.agent_access_enabled` (migration `0030`). It gates minting (`mintToken` throws `AgentAccessDisabledError`) **and** verify — toggling it off is a master kill switch: `verifyAndUnwrapDk` fails closed for every one of that user's tokens at once, re-enabling restores them, and it only ever touches that user's own DK/row. UI lives on Settings › AI & MCP (`src/app/(app)/settings/ai/page.tsx` + `agent-access-preference.tsx` + `agent-tokens-panel.tsx` + `agent-connect-guide.tsx`): opt-in switch, mint (name + **expiry selector** 1d/1w/1m/1y/never; one-time secret reveal + copy), a multi-language **connect guide** (Claude Code / Claude Desktop / Codex / curl, endpoint built from the request host), list (label / created / last-used / expires / status), rotate (mint replacement + revoke old, inheriting the label), revoke (inline confirm). API at `src/app/api/agent-tokens/route.ts` (+ `[id]`); mint/rotate read DK from the live web session. Dates formatted server-side (hydration rule). Verified in the browser end to end at both 500px and desktop widths (opt-in → mint incl. a never-expiry token → reveal → connect-guide tabs → rotate/revoke confirm).
- **Token TTL is user-chosen** (migration `0032`): `agent_tokens.expires_at` is now nullable, `null` = never expires. `mintToken`'s `ttlMs` is `number | null` (null ⇒ no expiry); verify skips the expiry check when it is null. Revocation + the opt-in kill switch remain the real controls; TTL is only a backstop.
- **OAuth for Claude and ChatGPT connectors — done.** `mcp_oauth_auth_codes` and `mcp_oauth_grants` are owner-scoped/RLS-protected DK envelopes. Root well-known routes advertise RFC 9728 protected-resource metadata and RFC 8414 authorization-server metadata with CIMD, PKCE S256, public-client auth (`none`), and `offline_access`. `/api/oauth/authorize` validates allowlisted/self-referential Claude or ChatGPT CIMD and renders consent behind a live session; `/api/oauth/token` accepts form-encoded code and refresh grants; `/api/oauth/revoke` is idempotent. Access tokens are stateless AEAD envelopes and check the grant on every MCP request; refreshes rotate atomically. OAuth grants appear beside static tokens in Settings › AI & MCP and can be revoked there. `agent_access_log` attributes each call to exactly one static token or OAuth grant, enforced by a database check constraint.
- **Capability discovery** is protocol-native: `tools/list` returns each tool's description + JSON schema and marks every tool with `readOnlyHint: true`; `initialize` returns `SERVER_INSTRUCTIONS` (`src/lib/mcp/server.ts`) — a server-level brief (read-only, exact-decimal, which tool to prefer, untrusted-data framing). **Keep `SERVER_INSTRUCTIONS` in sync when the tool surface changes — notably when the deferred DSL lands.** No separate hosted docs or Claude Code skill are shipped for v1.3.

## 8. Out of scope for this document

- **In-app chat assistant** — deferred by #19 to propose-and-confirm; its model-backend binding (#3) and rules-only degradation go with it.
- **Any AI write path / propose-and-confirm** — no write tool exists in v1.0/1.3 (vision, non-negotiable).
- **Persistent server-side warm-key window** — rejected (§2).
- **Local MCP shim** — rejected (§2); prototype #22 closes.
- **Third-party identity providers or arbitrary OAuth clients** — Moni's built-in authorization server intentionally accepts only allowlisted Claude and ChatGPT CIMD clients; general federation and DCR remain out of scope.
- **AI Insights / proactive background agents, Telegram bot** — not in v1.0 scope.

**Related:** `../security/threat-model.md` (§5.6, §6, §9) · `../security/security-design-principles.md` · `domain-layer.md` · `encryption.md`
