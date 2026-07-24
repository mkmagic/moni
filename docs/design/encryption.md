# Moni — Encryption Implementation Guide

This document provides actionable guidelines for implementing encryption in Moni. For the reasoning and broader security context behind these rules, you **must** consult:
- @../security/security-design-principles.md
- @../security/threat-model.md

## 1. Cryptographic Primitives
- **AEAD Algorithm:** Use **XChaCha20-Poly1305** for all authenticated encryption.
- **Key Derivation (Passwords):** Use **Argon2id** as the fallback for password-based unlock.
- **Key Derivation (Passkeys):** Prefer the **WebAuthn PRF extension** for primary authentication.

## 2. Key Management (RAM-Only)
- **Envelope Encryption:** Use a per-user data key to encrypt user data. This data key is itself wrapped by the user's unlock key (derived from their passkey or password).
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
- **Aggregate in the app tier, not over ciphertext:** SQL cannot `SUM` / `GROUP BY` encrypted amounts. In v1.0, dashboards narrow on the plaintext structural columns, decrypt the narrowed set, and aggregate in the domain layer with `decimal.js` — **no persisted rollups** (an encrypted rollup is a read-modify-write with a lost-update race under concurrent ingest; deferred to a future single-worker cache, added only if measured slow). See @data-model.md §4.3/§6.

## 4. Application & Agent Context
- **AI Agents:** Agents are **read-only** in v1.0. Do not construct write paths for AI agents.
- **Decryption Requirements:** Headless or MCP agent reads are only possible when the user's data key is actively in RAM (a live unlock window or an opt-in warm key). An API/MCP identity provides authorization only, not a decryption capability.
- **Worker Confinement:** The worker is the only component that touches plaintext bank credentials. It must wipe these credentials from memory immediately after the scrape finishes.
