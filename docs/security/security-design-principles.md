# Moni — Security Design Principles
Bottom-line guidance for building Moni securely. This is the "what to do" distilled from `threat-model.md` — read that for the reasoning. If a decision here seems wrong for a new situation, go back to the threat model before deviating.

## Overview
Moni is **self-hosted by one technical owner** and **multi-user** (family). Security is tiered — the bar is deliberately high in a few places and deliberately relaxed elsewhere. Do not spread effort uniformly; spend it on the crown jewels.

### What we protect (hard lines)
- **Bank/broker credentials, encryption keys, recovery codes (Tier 0)** — must be unrecoverable from a stolen disk, DB, or backup.
- **Cross-user isolation (Tier 1)** — one family member must *never* see another's data. This is the single most important invariant.
- **Account numbers & amounts at rest** — encrypted so untrusted storage (stolen disk/backup, DB snapshot, third-party DB host) learns nothing.
- **Everything in transit** — TLS on every hop.

### What we accept (do not over-engineer these)
- **The app host sees Tier-1 plaintext at processing time.** Server-side scraping makes this unavoidable; we do not try to hide financial data from the running box. Do **not** promise "the owner can't see your data."
- **Structural metadata leaks to storage.** Dates, category ids, currencies, row counts, and account↔transaction relationships stay in plaintext (they must, for querying). We protect account numbers and amounts — not the shape/timing of activity.
- **Scraper fragility & bank ToS.** An operational/relationship risk, not a confidentiality one. Fail safely; keep connectors swappable.

## Concrete steps
### Key custody & credentials
1. **Envelope encryption per user.** A per-user data key encrypts that user's secrets/fields; the data key is wrapped by a key derived from the user's **unlock secret** (passkey or password). Plaintext keys live **only in RAM**, never on disk or swap.
1b. **The login password must not be able to open bank credentials** (issue #7, requirement from #18). Two keys: the **data key (DK)** for Tier-1 fields, wrapped by the password's Argon2id KEK; the **credential key (CK)** for Tier-0 bank credentials, wrapped **only** by a WebAuthn-PRF passkey. Never add a password-derived wrap of CK, a "dev-only" env flag that re-enables one, or a recovery path for CK — each of those restores the exact attack this closes (a helper that prompts for the Moni password is indistinguishable from one that harvests it). Recovery codes wrap DK only.
2. **Prefer WebAuthn/passkeys with the PRF extension** to derive the unlock key from a biometric/security-key tap. Fall back to a password via **Argon2id** — for DK only; per 1b there is no password fallback for CK, and a device that cannot do PRF cannot use bank scraping. AEAD everywhere = **XChaCha20-Poly1305**.
3. **Make the PRF unlock replay-proof.** PRF is evaluated in the browser and its output travels to the server, so it is a replay target. Transmit only over TLS; bind every unlock to a **fresh WebAuthn assertion with a server-issued challenge** (prove a live touch, not a replayed value); rate-limit it; bind the unlocked state to a short-lived secure `HttpOnly` session; derive the key and **wipe the raw PRF immediately** (step 5). Never store or log the PRF output.
4. **Never store a bank credential (or any token) unencrypted**, at any point — including onboarding. Encrypt before the first write.
5. **Handle Tier-0 secrets as wipeable binary, never `String`.** In Node/V8, `String`s are immutable and GC-managed — you *cannot* zero them, and copies linger on the heap. Handle all Tier-0 material (bank passwords, derived/unwrapped keys, recovery codes, raw PRF output) strictly as **`Buffer`/`Uint8Array`**, and **`buffer.fill(0)` immediately after use**. Avoid APIs that force a string copy (JSON, concatenation). *Known residual:* `israeli-bank-scrapers` takes credentials as strings — bound this by running the **worker as a short-lived process** (spawn per scrape, exit after) so its heap is torn down promptly.
6. **The worker is the only component that touches plaintext credentials**, and only for the duration of a scrape. Wipe the key and plaintext (step 5) immediately after.
7. **Bounded in-memory unlock window** (password-manager model): unlock once per session; hold the key in-process for a bounded TTL; wipe on expiry/logout/restart. Unattended auto-decrypt, if ever offered, is **opt-in and owner-only**.
8. **Recovery codes**: generate one-time codes that independently unwrap the data key; display once; store only a hash; force a new unlock secret + invalidate the used code on redemption. State plainly that losing both = unrecoverable.

### Cross-user isolation
9. **PostgreSQL Row-Level Security (RLS) on every user-owned table** as the backstop — `owner = current_user_id`, set per request/transaction (`SET LOCAL app.user_id`), with the app connecting as an RLS-subject role. This stands even if application code forgets a `WHERE`.
10. **All DB access goes through the single domain/service layer** — no second path. Every query is user-scoped. No "admin reads everyone" path in v1.0.
11. **Tenancy is part of the MCP/agent call context**, never left to individual tools to remember. Agents are read-only in v1.0 and bound to exactly one user.
12. **Maintain a cross-tenant test suite** that asserts user A cannot reach user B's rows via API or MCP.

### Data at rest
13. **Encrypt the sensitive Tier-1 fields at the application/worker tier**: amounts, descriptions/counterparties, account numbers, holdings values/quantities, free-text notes. Encrypt with a **key the DB never sees**.
14. **Leave structural columns plaintext** (ids, user id, currency, date, category id, account type) so SQL can filter/group. This is intentional (accepted metadata leakage).
15. **Bind each ciphertext to its location and version**: random nonce per value + AAD = row id + column + **a monotonic row version** (`updated_at`/counter). Row+column binding stops value-swapping between rows/users; the version blocks **rollback** (a DB-write attacker reinstating an old valid ciphertext). *Against an active DB-write attacker, the expected version must be anchored outside the DB* (per-user counter / signed head), or they roll back ciphertext and version together.
16. **Decrypt-then-aggregate in the app tier — no persisted rollups in v1.0.** SQL can't `SUM`/`GROUP BY` ciphertext, so dashboards filter on the plaintext structural columns, decrypt the narrowed set, and aggregate in app memory with `decimal.js`. At family scale (~10⁴–10⁵ rows) this is ms-fast. A persisted encrypted rollup cache is **deferred** — it is an encrypted read-modify-write with a lost-update race under concurrent ingest, so if ever built it belongs to a single serialized worker off the ingest path (threat-model §7.5; `data-model.md` §4.3/§6).
17. **Enable full-disk encryption (LUKS) + encrypted backups** regardless — the cheap baseline.
18. **A third-party managed DB is allowed** *only* as ciphertext-only storage: keys stay in the app tier; the provider never runs plaintext-dependent features on sensitive fields.

### Data in transit
19. **TLS on every hop, no exceptions.**
    - Browser/MCP → app: **HTTPS only**, TLS 1.2+, HSTS, `Secure`/`HttpOnly`/`SameSite` cookies. Never serve login over plain HTTP.
    - App → Postgres: **`sslmode=verify-full`** (not `require` — it must verify identity), *especially* for a third-party DB over the internet.
    - Worker → bank: never disable certificate validation (no `--ignore-certificate-errors`, no `rejectUnauthorized: false`).
    - App → LLM/market data: HTTPS by default; local Ollama over loopback.

### Deployment & network isolation
20. **Network-egress-filter the worker.** The worker runs the untrusted Puppeteer/scraper stack with plaintext credentials in memory, so a supply-chain or Chromium exploit could read them. Confine the worker container at the network level (Docker network policy / `iptables`) to **outbound: whitelisted bank domains + PostgreSQL only**; block all other egress so leaked credentials have nowhere to be POSTed.

### AI / model boundaries
21. **v1.0 is read-only end to end** — no AI write path anywhere. Propose-and-confirm is a future version.
22. **Rules-first categorization**; only the unmatched tail goes to a model. Moni must run in rules-only mode with no model configured.
23. **The model backend is user-configurable** (incl. local). *Which* external model a user connects to is the user's privacy decision — Moni's job is to authenticate the connection and confine it to that user's data, not to police the destination.
24. **Treat ingested strings as untrusted model input (prompt injection).** Transaction descriptions and merchant names come from outside the trust boundary and can carry injected instructions. Pass them to the model inside **clearly tagged data fields, never concatenated into the instruction portion**; the system prompt says content in those tags is *data, not instructions*. **Sanitize/defang model output** (links, markup) before showing it. The read-only + per-user confinement (steps 9–11, 21) is the backstop that caps the blast radius — prompt injection is not fully solvable, so revisit before ever adding a write path.
25. **Headless/MCP reads need a live key — decide it, don't infer it.** Encrypted fields *and any aggregate derived from them* can only be read while the user's data key is in RAM, and the **MCP/API identity is authorization only, never a decryption capability** (a key that unwraps data would make a stolen API key Tier-0). *Default:* an agent reads encrypted data **only within an active unlock window**; with none open it sees only non-encrypted structural data — so MCP is a live assistant, not a 24/7 autonomous querier. No scheduler or unattended scrape is part of v1.0. (§5.6)

### Dependencies & auth hygiene
26. **Minimize and audit the surface that touches plaintext credentials** (the worker). Pin dependencies; keep credential-handling code small and reviewed. `israeli-bank-scrapers` + its Puppeteer stack is untrusted supply chain.
27. **Passkeys/WebAuthn as primary auth**; where passwords exist, add TOTP + brute-force protection. Standard secure-session, CSP, and security headers.
28. **Fail scrapes safely** — never partial-write a corrupt balance; surface breakage to the user; keep every connector behind the generic interface.

## Sanity checks
Before shipping any change, ask:
- **Is any sensitive field (amount, description, account number, holding, credential) sitting in the DB unencrypted?** It must not be.
- **Does the encryption key ever reach the DB, disk, swap, logs, or a backup?** It must not — keys live in RAM only.
- **Are Tier-0 secrets handled as `Buffer`/`Uint8Array` and `fill(0)`-wiped after use — never left in an immutable `String`?** If a secret is a `String`, it's unwipeable and lingering.
- **Could a stolen disk/DB/backup yield a usable bank credential or a readable amount/account number?** If yes, it's broken.
- **Can this query/endpoint/tool return another user's row?** Is it scoped *and* covered by RLS *and* covered by a cross-tenant test?
- **Does the AEAD AAD bind a row version, and is the expected version anchored outside the DB if we're defending against active DB writes?** Otherwise rollback is possible.
- **Is every network hop TLS-protected, and is `sslmode=verify-full` (not `require`) set to the DB?**
- **Is the worker egress-filtered to bank domains + Postgres only?** A credential leak with open egress walks out the door.
- **Is the PRF unlock bound to a fresh WebAuthn assertion + short-lived session, not a replayable stored value?**
- **Are ingested transaction/merchant strings passed to the model as tagged data, never as instructions — and is model output sanitized before display?**
- **Does any MCP/agent read decrypt without a live unlock window (or the owner's opt-in warm key)? Does the API key itself grant decryption?** It must not — the identity is authorization only; encrypted reads need a key in RAM.
- **Am I about to claim "the owner/host can't see this"?** Don't — that's false for Tier-1 at processing time.
- **Did I add an AI write path?** Not in v1.0.
- **Does the app still work with no model backend configured (rules-only)?** It must.
- **Is a new dependency touching plaintext credentials?** Justify, pin, and review it.
- **If a scrape fails mid-way, can it corrupt stored balances?** It must fail atomically.
- **Are credentials encrypted before the very first write during onboarding?** No plaintext window, ever.
