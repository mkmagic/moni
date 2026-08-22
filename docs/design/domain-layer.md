# Moni — Domain / Service Layer

**Purpose:** The single access path all reads and writes go through — and how cross-user isolation (RLS) is wired into it. 

This document defines the architectural rules and invariants for the domain layer, directly implementing the constraints from the data model and security principles.

---

## 1. The One-Write-Path Invariant

The domain layer is the **only component allowed to execute database queries**. 

- **App & API:** All UI actions, dashboard queries, and API endpoints must call domain-layer functions. There is no query bypass.
- **Worker:** Background jobs (scraping, FX fetching) must import and call domain-layer methods. They must not write to the database directly. There is **no job queue in v1.0** — the scrape worker is a `tsx` child process spawned fire-and-forget by the sync route (`scripts/scrape-worker.mts`). A Postgres-backed queue (`pg-boss`) is the intended destination but is not installed, so anything that would need scheduling either runs inline in an existing request/transaction or is deferred.
- **MCP (AI Agents):** All LLM/agent interactions route through the domain layer. 

**v1.0 is strictly read-only for AI.** The domain layer exposes only read methods to the MCP interface. Propose-and-confirm writes are deferred to future versions.

---

## 2. Per-Request User Scoping & RLS

Cross-user isolation is Moni’s single most important security invariant. 

### 2.1 The RLS Backstop
Every user-owned table is protected by PostgreSQL Row-Level Security (RLS) policies requiring `owner_id = current_setting('app.user_id')::uuid`. 
- The application connects to the database as an **RLS-subject role** (not as a superuser or table owner).
- Before executing any business logic query, the domain layer must execute: `SET LOCAL app.user_id = '<current_user_id>'` within the transaction or connection scope.
- This guarantees that even if a domain function forgets a `WHERE owner_id = ?` clause, the database will refuse to return another user's rows.

### 2.2 Tenancy Context
Tenancy is established at the boundary (API middleware, worker job context, or MCP connection) and passed down. It is never inferred by the database connection pool. 

- **No "Admin Reads Everyone":** There is no bypass path in v1.0 that allows reading all users' data at once.

---

## 3. Core Responsibilities

The domain layer acts as the orchestrator for validation, security, and business rules.

### 3.1 Encryption & Decryption Boundary
The domain layer is the sole entity that encrypts and decrypts Tier-1 and Tier-0 data. The database only sees ciphertext.
- **Before Write:** The domain layer generates a nonce, binds the AAD (row id + column name + version), encrypts the data using the user's unwrapped data key, and stores the ciphertext (`*_ct`).
- **After Read:** The domain layer decrypts the fields before returning them to the caller.
- **Key Custody Requirement:** To process encrypted fields, the domain layer requires the user's unwrapped data key to be present in RAM. If the key is unavailable, the domain layer can only read/write plaintext structural columns.

### 3.2 Validation & Attribute Locking
- **Validation:** All inputs are validated (e.g., using Zod) at the edge of the domain layer.
- **Attribute Locking Enforcement:** The domain layer inspects the `locked_attributes` JSONB map on `entries` and `accounts`. If an update (from a rule, a background job, or an AI model) attempts to modify a locked field, the domain layer must drop that specific field update while allowing the rest of the payload through. The user is the only actor who can override a locked attribute.

### 3.3 On-the-Fly Aggregation (Decrypt-then-Sum)
Because the database cannot sum encrypted amounts:
1. The domain layer queries the database filtering by plaintext structural columns (e.g., date ranges, `category_id`).
2. It fetches the narrowed row set.
3. It decrypts the amounts (`entered_amount_ct`, `account_amount_ct`).
4. It computes the `reporting_amount` (by multiplying the entered amount by the locked `fx_rate`).
5. It aggregates the totals in memory using `decimal.js` (no floats).
- **No Persisted Rollups:** v1.0 relies entirely on this memory aggregation to avoid the lost-update races inherent in encrypted read-modify-write rollups.

---

## 4. API vs. MCP Read Surfaces

The domain layer exposes two distinct interfaces to accommodate different consumers:

### 4.1 The API Surface (UI/Frontend)
- **Full Capabilities:** Can read, write, update, and delete (subject to RLS and user ownership).
- **Assumes Live Key:** Typically operates during an active browser session where the unlock secret has been verified and the data key is held in RAM.
- **Derived Data:** Returns aggregated dashboards and computed reporting currencies.

### 4.2 The MCP Surface (AI Agents)
- **Read-Only (v1.0):** Cannot create, modify, or delete entries, rules, or categories.
- **Data Tagging:** The domain layer wraps untrusted fields (like transaction descriptions or merchant names) in specific data tags before handing them to the MCP to mitigate prompt injection.
- **Per-request DK unwrap:** A user who has opted in mints a **per-user agent token** that lets the server unwrap **that user's DK for the duration of a single request** (threat-model §5.6, `mcp-and-api.md`). The domain layer decrypts, aggregates, and wipes DK within the request — no standing key. A request without a valid token (or for a user who has not opted in) serves only non-sensitive structural data. **DK only, never CK:** no agent path can arm the credential window or reach bank credentials.
- **Explicit Denials:** If an agent attempts to write, or requests encrypted data without a valid token, the domain layer returns an explicit, handled error.

---

## 5. The Cross-Tenant Test Suite

To guarantee that the RLS backstop and domain-layer scoping work flawlessly, Moni requires a dedicated cross-tenant test suite that tests the domain layer directly.

**Test Requirements:**
1. **Direct Access Denial:** Attempt to read User B's entry while `app.user_id` is set to User A. Must return zero rows (RLS check).
2. **Composite FK Denial:** Attempt to create an entry for User A that references User B's `account_id` (the `(owner_id, id)` composite FK check). Must fail at the database level.
3. **No-Session Decryption Failure:** Attempt to call a domain read method for Tier-1 data without providing a valid data key in memory. Must fail gracefully.
4. **Agent Confinement:** Execute an MCP read request disguised as User A trying to fetch User B's data. Must return empty or error.
