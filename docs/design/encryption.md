# Moni — Encryption Implementation Guide

This document provides actionable guidelines for implementing encryption in Moni. For the reasoning and broader security context behind these rules, you **must** consult:
- `../security/security-design-principles.md`
- `../security/threat-model.md`

## 1. Cryptographic Primitives
- **AEAD Algorithm:** Use **XChaCha20-Poly1305** for all authenticated encryption.
- **Key Derivation (Passwords):** Use **Argon2id** as the fallback for password-based unlock.
- **Key Derivation (Passkeys):** Prefer the **WebAuthn PRF extension** for primary authentication.

## 2. Key Management (RAM-Only)
- **Envelope Encryption:** Use a per-user data key to encrypt user data. This data key is itself wrapped by the user's unlock key (derived from their passkey or password).
- **Two keys, not one (issue #7, requirement from #18).** The per-user **data key (DK)** covers Tier-1 fields and is wrapped by the login password's Argon2id KEK. The **credential key (CK)** covers Tier-0 bank credentials and is wrapped **only** by a WebAuthn-PRF passkey. The login password must never wrap CK on any row — that is what makes it structurally impossible for a phished password to reach a bank credential. Which keys a `user_unlock_methods` row opens is recorded by which of its two wrap columns is non-null. CK is minted lazily at the first passkey enrollment (`src/domain/credential-unlock.ts`), never at signup, and has **no recovery path** by design.
- **No Disk Storage:** Plaintext keys must **never** be written to disk, database, swap, or logs. They live exclusively in bounded, in-memory sessions.
- **Wipeable Memory (Crucial):** Handle all Tier-0 secrets (bank passwords, unwrapped keys, recovery codes, raw PRF outputs) strictly as **`Buffer` or `Uint8Array`**.
  - **Never use `String`** for Tier-0 secrets, as V8 strings are immutable and cannot be safely wiped.
  - Call `buffer.fill(0)` immediately after the secret is no longer needed.

## 3. Database & Data at Rest
- **Fields to Encrypt (Tier 1):** Amounts, descriptions, counterparties, account numbers, holdings (values/quantities), free-text notes, and any external credentials.
- **Fields to Leave Plaintext:** Structural metadata required for querying (e.g., IDs, `user_id`, currency, date, `category_id`, account type).
- **Ciphertext Binding (AAD):** Prevent ciphertext swapping and rollback by binding every encrypted value to its exact location using Additional Authenticated Data (AAD):
  - `AAD = row_id + column_name + row_version`
  - The `row_version` must be a monotonically increasing counter (e.g., `updated_at` or a specific version integer).
- **Aggregate in the app tier, not over ciphertext:** SQL cannot `SUM` / `GROUP BY` encrypted amounts. In v1.0, dashboards narrow on the plaintext structural columns, decrypt the narrowed set, and aggregate in the domain layer with `decimal.js` — **no persisted rollups** (an encrypted rollup is a read-modify-write with a lost-update race under concurrent ingest; deferred to a future single-worker cache, added only if measured slow). See `data-model.md` §4.3/§6.

## 4. Application & Agent Context
- **AI Agents:** Agents are **read-only** in v1.0. Do not construct write paths for AI agents.
- **Decryption Requirements:** A user may opt **their own** account into AI reads by minting a **per-user agent token** that lets the server unwrap **that user's DK for one request** (server decrypts, aggregates, wipes DK — no standing key). The token reaches **DK only** — never CK, which stays passkey-PRF-only and unreachable from any token/password KEK. Worst case a token yields is disclosure of that user's Tier-1 data; never write, never the bank, never another user. See `../security/threat-model.md` §5.6 and `mcp-and-api.md`.
- **Worker Confinement:** The worker is the only component that touches plaintext bank credentials. It must wipe these credentials from memory immediately after the scrape finishes.
