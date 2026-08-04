# Moni — Data-Source Connector Interface

**Purpose:** How Moni connects to a bank/credit-card institution, scrapes it, and lands the result in the ledger — with a plaintext Tier-0 bank credential never resident anywhere but a short-lived child process. `israeli-bank-scrapers` is the only v1.0 implementation.

**Status:** shipped and verified against a real bank account (Bank Leumi, three consecutive runs — see the plan's Progress log). This doc replaces an earlier stub that named pg-boss as the v1.0 mechanism; **pg-boss is not used here.** v1.0 sync is user-triggered only, spawned directly by the API route that handles the click.

**Related:** `../security/threat-model.md` §5 · `../security/security-design-principles.md` · `data-model.md` §5/§6 · `money-and-currency.md` · `../../.agents/skills/israeli-scraper/SKILL.md`

---

## 1. Shape of a connector

A connector is a static registry entry, not a plug-in class — `israeli-bank-scrapers` already provides the actual scraping logic (login automation, table scraping) per institution; Moni's job is describing what each one needs and normalizing what it returns.

`src/lib/connectors/types.ts` — `ConnectorDefinition`:

```ts
interface ConnectorDefinition {
  id: ConnectorId;
  label: string;               // display name ("Bank Leumi")
  kind: "bank" | "credit_card" | "investment";
  mode: "credentialed_fetch" | "user_mediated_import";
  loginFields: LoginFieldDescriptor[]; // ordered to match the scraper's credentials object
}
```

`src/lib/connectors/registry.ts` — `CONNECTOR_REGISTRY` is the concrete list: the `["username","password"]` banks, `hapoalim` (`userCode`), `isracard`/`amex` (`id`,`card6Digits`,`password`), `discount`/`mercantile` (`id`,`password`,`num`), `yahav` (`username`,`nationalID`,`password`). `oneZero` is deliberately excluded — it needs OTP, which this plain login-field shape can't express. `tests/unit/connector-registry.test.ts` is a drift gate: each entry's field keys must `===` the installed library's own `SCRAPERS[id].loginFields`, so a library upgrade that reorders or renames a field fails a test instead of silently breaking a login form.

The registry also contains `ibkr_flex` (`investment`, `credentialed_fetch`,
`flexToken` and `queryId`) and `schwab_positions_csv` (`investment`,
`user_mediated_import`, no credentials). UI and routes derive source mode from this
registry; they do not keep a second broker list. Credentialed connections require
`credentials_ct`; import connections require it to be null.

---

## 2. Credential custody: two keys, two RAM windows

`israeli-bank-scrapers` automates a real login, so *something* has to hold a plaintext bank credential. Moni never lets that something be the long-lived web process's session state. Two separate keys exist for two separate reasons:

- **Data key (DK)** — unwrapped at login, lives in `src/lib/auth/session-store.ts` for the session's 8-hour TTL. Decrypts ordinary Tier-1 fields (transaction descriptions, amounts, account numbers).
- **Credential key (CK)** — unwrapped only by a WebAuthn-PRF passkey assertion (`unlockCredentialKey()` in `src/domain/credential-unlock.ts`), lives in `src/lib/auth/cred-window.ts` for a separate, tighter 10-minute TTL (its own 60-second sweep, not the session store's 10-minute one — reusing that sweep against a 10-minute TTL would leave a window unswept for ~100% of its own life). Decrypts `connections.credentials_ct`, the Tier-0 bank login.

**The keys are wrapped by different factors, and that is the point** (issue #7, requirement from #18). DK is wrapped by the Argon2id(password) KEK; CK is wrapped only on `webauthn-prf` rows of `user_unlock_methods`, never by the password. So a stolen session cookie yields no bank credential, and neither does a phished Moni password. CK is minted at the first passkey enrollment — a user with no passkey has no CK and cannot store a bank credential at all. There is **no recovery path for CK**: lose every passkey and you delete the connection and re-enter the bank login. `endSession()` cascades to `destroyCredentialWindow()` and `clearPendingCeremony()` so logout wipes both windows and any half-finished ceremony.

**Everything that touches CK checks the window**, including the first credentialed
connect. `POST /api/connections`, `PATCH /api/connections/[id]` (credential
replacement), and credentialed `POST /api/connections/[id]/sync` return **`423
Locked`** with `{ error: "credential_window_locked" }` when it is closed. That covers
bank connectors and IBKR Flex. Schwab Positions CSV is an import connection: it has
no reusable credential, does not require CK, and its bounded Tier-1 upload is handled
with the active data key. The client arms and retries credentialed actions once; a
new passkey enrollment leaves the window armed.

**Arming is two requests.** `POST /api/connections/arm/options` issues a single-use, server-issued challenge (RAM, per session); `POST /api/connections/arm` verifies the assertion — signature *and* the user-verification flag, via `@simplewebauthn/server` — then HKDFs the PRF output to the KEK that unwraps CK. Enrollment is the same shape at `/api/passkeys/options` and `/api/passkeys`, except it pairs a `create` ceremony with an immediate `get`: only the assertion's PRF output is trusted to wrap CK, because a wrap that only the create ceremony can open is a wrap nobody can ever open.

---

## 3. The spawn-per-scrape child process

`israeli-bank-scrapers`'s API takes credentials as plain JS `String`s — an unavoidable residual, since `String`s are immutable and can't be wiped. The mitigation is a **short-lived process per scrape**: `scripts/scrape-worker.mts`, spawned once by the sync route via `child_process.spawn("tsx", [...])` and torn down as soon as the scrape and promotion finish, so the heap holding that string doesn't persist.

The parent (`src/app/api/connections/[id]/sync/route.ts`):
1. Checks the credential window (423 if closed).
2. Decrypts `credentials_ct` with CK **in the parent process** — the child never sees CK or ciphertext, only the resulting plaintext credential strings.
3. Sets `sync_runs.status = 'running'` itself, right after deciding to spawn — not something the child reports back.
4. Spawns the child and writes one framed message to its stdin, then returns `202 { syncRunId }` immediately. The scrape is never awaited by the HTTP response; the UI polls `GET /api/sync-runs/[id]` instead.

**stdin framing** (`src/lib/connectors/child-stdin-framing.ts`) is deliberately not one JSON blob, because JSON-encoding the data key would force it through `JSON.stringify` as a base64 string — an unwipeable V8 `String`, which defeats the entire point of holding it as a `Buffer`. The frame keeps DK as raw bytes and puts everything else (ids, dates, and the credential strings — unavoidably strings either way) in a length-prefixed JSON section:

```
[4B BE uint32 dataKeyLen][DK raw bytes]
[4B BE uint32 jsonLen]   [UTF-8 JSON: {syncRunId, userId, connectionId, connectorId, startDate, credentials}]
```

`encodeChildStdinFrame`/`decodeChildStdinFrame` are pure functions (`tests/unit/child-stdin-framing.test.ts` exercises them without spawning anything). The data key passed to the child is the **live session's own `Buffer`, borrowed, not copied-and-owned** — the parent must never wipe it after spawning (only `destroySession()`/expiry may). The child, on the other hand, wipes its own stdin-derived copy of the frame and the data key in a `finally` once it's done — that copy really is its own.

**Runs via `tsx`, not a compiled build**, in both dev and production. Nothing imports `scrape-worker.mts`, so `next build` never bundles it and there's no second build target to forget to rebuild. Revisit only if a slim Docker image that strips `devDependencies` shows up.

**Failure handling.** The parent enforces a 5-minute SIGTERM timeout, then SIGKILL 5 seconds later if the child hasn't exited. On the child's `exit` (any code/signal) or a spawn-level `error`, the route calls `markSyncRunFailed()` as a safety net — guarded by `WHERE status='running'`, so it's a no-op whenever the child's own catch (clean failure) or `promoteScrapeResult` (clean success) already resolved the run. Known accepted nuisance: SIGKILL can orphan a Chrome process; process-group management isn't worth building for a family-scale app. If the *parent itself* dies mid-scrape (no exit/error event ever fires), a lazy self-heal in `getSyncRun()` flips any `running` row older than 15 minutes to `failed` the next time anyone polls it — no cron, no scheduler.

---

## 4. Scrape window

`startDate` is computed server-side (`computeSyncStartDate()` in `src/domain/sync-promotion.ts`), never chosen by the user:

```
startDate = min(today − 30d, lastSyncAt − 7d)
```

A brand-new connection has no `lastSyncAt`, so onboarding's first scrape collapses to exactly 30 days — comfortably inside the 5-minute child timeout. The `lastSyncAt − 7d` arm closes the gap a user who skips syncing for a couple of months would otherwise permanently lose (nothing else ever goes back for missed data), and the 7-day overlap is free because reconciliation is proven idempotent. The sync route accepts an optional `startDate` body override, so a future backfill feature needs no new route.

---

## 5. From scrape output to ledger rows

### 5.1 Validate, then leave `number` behind immediately

The scraper's raw result is Zod-parsed (`scraperScrapingResultSchema`) — the real untrusted-input boundary; nothing past that point is trusted shape. Amounts arrive as JS `number` from the library and are converted to exact decimal strings in exactly one place, immediately after validation:

```ts
// src/lib/money/from-scraper-number.ts
decimalStringFromScraperNumber(n: number): string
```

`String(n)` first (V8's shortest round-tripping representation), then through `Decimal`. Everything downstream of that call — the whole promotion pipeline — is `Money`-shaped decimal strings; the float never reappears.

### 5.2 Account resolution — decrypt-and-match, not a blind index

`resolveAccount()` in `src/domain/sync-promotion.ts` decrypts every account row's `external_account_ref_ct` under DK inside the sync transaction and compares it to the scraper's `accountNumber`. A family has on the order of ten accounts, so this is cheap; no blind-index/HMAC scheme was needed. No match creates a new `accounts` row (id generated before any encryption, since the AAD binds to it).

### 5.3 Reconciliation key

`computeImportKey()` (`src/lib/connectors/import-key.ts`) hashes **stable fields only** — banks mutate `description` and the posted date when a pending charge posts, so neither is an input:

```
sha256( connectorId ⋅ accountId ⋅ (identifier ?? "no-id") ⋅ originalAmount ⋅ originalCurrency ⋅ date )
```

`accountId` is the already-resolved internal account id (plaintext), not the scraper's raw account number. `date` is always the transaction's *purchase* date, never `processedDate`.

Fields are joined by `\x01` (SOH), shown as `⋅` above. The separator is not cosmetic: a control byte cannot occur in any of these inputs, so field boundaries stay unambiguous and no pair of distinct field tuples can concatenate into the same string. Note that `\x01` renders invisibly in most editors and file-reading tools — `SEPARATOR` in `import-key.ts` looks like an empty string unless you hex-dump it. Do not "fix" it.

**Documented limitation, not engineered around:** connectors that omit `identifier` collapse two genuinely different same-day, same-amount charges on one account into a single key. Folding `description` in would defeat pending→posted stability; a run-counter isn't stable across overlapping re-scrapes. This is a data-source constraint, accepted as-is — task 13's real-bank run independently confirmed 13 entries with 13 distinct import keys, including two same-day same-account charges that *did* carry distinct identifiers.

### 5.4 The three promotion branches

`promoteTransaction()` always logs the raw scraped payload to `sync_staging` first, then branches on an `entries.import_key` lookup:

- **New** → insert `entries` + `entry_transactions`, staging row `promoted`.
- **Matched, unchanged** → staging row `matched`, nothing else touched. This is what makes re-running a scrape a no-op — the property task 13 proved with three consecutive real-bank runs (13 new → 0 new/13 matched → identical).
- **Matched, pending → posted** → **updates the existing entry in place** (never a second row), bumping `version` and re-encrypting *every* ciphertext column on that row — `description_ct`, `notes_ct`, `entered_amount_ct`, `account_amount_ct` — even the ones whose plaintext didn't change. `version` is one column shared by every ciphertext column on a row; touching only the changed column while bumping `version` would leave the untouched ones silently undecryptable on the next read. The same re-encrypt-everything discipline applies to `refreshAccountCachedBalance()` when a scrape reports an updated account balance.

### 5.5 FX

`entered_currency`/`entered_amount` come straight from `originalAmount`/`originalCurrency`; `account_currency`/`account_amount` from `chargedAmount`/(`chargedCurrency` ?? the account's own currency); `reporting_currency` is the user's `baseCurrency`. When `entered_currency === reporting_currency` the rate is `1`, `fx_status = 'locked'`, no lookup. Otherwise `fx_rates(entered → reporting, date)` is looked up; a miss leaves `fx_rate = null, fx_status = 'pending'` — **never faked to 1:1** (money-and-currency.md §4). Only the `entered → reporting` leg is ever computed this way; the account leg is the bank's own verbatim figure and never enters the calculation.

### 5.6 One transaction, one atomic-failure contract

Account resolution, the staging log, entry promotion, balance snapshots, and the final `sync_runs → 'succeeded'` write all happen inside **one `withUser()` transaction**. Anything that throws partway rolls the whole scrape back — a failed run never partial-writes, and `sync_runs` is never left `succeeded` for one. `markSyncRunFailed()` runs in a deliberately **separate** transaction, written from the caller's outer `catch` after the attempt above has already rolled back — the atomic-failure contract needs the failure record itself to survive the rollback that wiped everything else.

---

## 6. `sync_runs` lifecycle and the polling contract

```
pending/running ──succeeded──▶ (entries visible)
                └──failed────▶ error message on the row
```

The sync route sets `running` itself right after deciding to spawn (before the child has even started). The UI never blocks on a sync — it gets `202 { syncRunId }` back immediately and polls `GET /api/sync-runs/[id]`. That same read also carries the orphaned-run self-heal from §3: a `running` row untouched for 15+ minutes is flipped to `failed` on read, guarded by `WHERE status='running'` so a genuine concurrent update can't be clobbered.

---

## 7. What's deferred, explicitly

pg-boss and any scheduled/unattended sync (v1.0 is user-triggered only — every sync starts from a browser click) · connectors beyond the registry, especially `oneZero`/anything needing OTP · a manual review queue before promotion (v1.0 auto-promotes) · a cron-based orphaned-run sweeper (the lazy on-read check in §3/§6 is the whole mechanism) · Chrome/Docker production packaging · a concurrency guard on the sync route (two simultaneous syncs for one connection currently spawn two children — data-safe because promotion is idempotent, but wasteful).

---

## 8. Investment sync contract (Moni 1.1)

Investment connectors reuse the `sync_runs` polling lifecycle and the short-lived
worker boundary, but normalize account state rather than ledger activity. IBKR Flex
XML and a Schwab Positions CSV must produce one source-neutral envelope before the
domain layer sees them:

```ts
interface InvestmentSyncEnvelope {
  source: "ibkr_flex" | "schwab_positions_csv";
  coverage: {
    kind: "configured_query_accounts" | "bound_single_account";
    accountRefs: string[];
  };
  sourceAsOf: { value: string; precision: "date" | "timestamp" };
  accounts: Array<{
    sourceAccountRef: string;
    baseCurrency: string;
    positions: Array<{
      sourceSecurityId: string;
      sourceSecurityIdKind: string;
      symbol?: string;
      name?: string;
      exchange?: string;
      assetKind: "stock" | "etf" | "mutual_fund" | "generic";
      quantity: string;
      quantityUnit: string;
      currency: string;
      sourcePrice?: string;
      sourcePriceCurrency?: string;
      sourceValue?: string;
      sourceValueCurrency?: string;
      sourceAsOf?: string;
    }>;
    cash: Array<{ currency: string; amount: string }>;
    brokerTotal: { amount: string; currency: string; asOf: string };
  }>;
}
```

Every decimal remains text at the source boundary and becomes encrypted before its
first write. Provider identifiers and account references are sensitive too. The
worker retains neither raw XML/CSV nor the uploaded file; it returns normalized
values, structural provenance, and a keyed normalized fingerprint. Logs and error
metadata contain codes and counts, never credentials, URLs, account identifiers,
symbols, quantities, prices, or raw rows.

### 8.1 Coverage, identity, and completeness

- IBKR coverage is every account configured into the Flex query. The stable IBKR
  account identifier may discover an account. Every covered account promotes or
  none does.
- A Schwab connection is bound by its first accepted file to one masked account
  reference and user-confirmed valuation currency. A later mismatch fails; another
  account needs another connection. Aliases and display names are never identity.
- Accounts outside declared coverage are untouched. A previously known covered
  account missing from the response fails the sync; the connector cannot reinterpret
  an incomplete response as narrower successful coverage.
- Zero holdings are accepted only when the identified account has an authoritative
  as-of, complete position and cash sections, and an exact zero broker total. Blank
  input, no discovered accounts, or omission preserves the prior snapshot and fails.
  Closure and archival are explicit user actions.
- Repeated source rows aggregate only when identity, asset kind, quantity unit,
  currency, valuation basis, and source time are compatible. Compatible cash rows
  aggregate by currency. Any conflict rejects the whole declared coverage.

### 8.2 Promotion, ordering, and failure

The route creates a `running` row before spawning. The worker fetches or reads,
validates, and normalizes the entire declared coverage in memory. Only after every
account passes does one domain-service call promote all covered snapshots inside one
`withUser()` transaction, under RLS, and mark the run `succeeded`. The outer catch
records a safe failure in a separate guarded transaction after rollback.

The keyed normalized fingerprint makes an identical repeat a no-op. Within the same
source week, a newer source time replaces the active observation; changed content at
the same source time is a correction and the later accepted import wins; an older
source time fails as `stale_source`. Ingestion time is only the correction tie-break.
The worker may retry bounded transient network failures before promotion. Auth,
schema, identity, completeness, and reconciliation-input failures are not retried
automatically; the user can start a new run.

The UI polls the existing `running`/`succeeded`/`failed` states. A browser closing
does not cancel the worker. Timeouts, worker exit, server shutdown, and the existing
lazy orphan repair fail safely. Moni 1.1 has no cancel control; disconnect is disabled
while the connection has a running sync. Disconnect removes future source access but
preserves accounts and snapshots, archive explicitly removes an account from current
views, and permanent deletion remains a separate destructive action.

### 8.3 Market estimates are not source promotion

A user-triggered current-value refresh may separately ask Tiingo for the latest EOD
close of each supported active USD ETF or common stock on NYSE or Nasdaq. This
best-effort worker receives the instance-wide market-data token but no broker
credential or source file. It parses exact CSV decimals and records explicit quote
currency and source date. It never changes sync coverage or the acceptance of an
IBKR/Schwab snapshot.

The current estimate uses last accepted quantity × latest usable close plus
last-known cash. A missing, unresolved, more-than-seven-day-old, or post-split quote
falls back to broker-observed value with explicit basis and staleness. Weekly history
always uses the source-date snapshot. Reads make no external request and there is no
scheduler; one user action may refresh the local quotes at most once per day.

Tiingo is disabled unless both `MONI_TIINGO_TOKEN` and
`MONI_TIINGO_MULTI_USER_AUTHORIZED=true` are present. The latter is an explicit
operator attestation that the instance has provider permission to use its shared
token for multiple users; without either setting, refresh is a local no-op and the
broker fallback remains the product behavior.

### 8.4 Investment-worker egress

Deployment policy is part of this boundary, not an application allowlist: see
[`../deployment/egress.md`](../deployment/egress.md). IBKR workers may reach only
`ndcdyn.interactivebrokers.com` and PostgreSQL; Schwab import workers may reach only
PostgreSQL; BOI workers may reach only `edge.boi.gov.il` and PostgreSQL; Tiingo
workers may reach only `api.tiingo.com` and PostgreSQL and receive no broker
credentials. Code also pins origins and rejects redirects, but that does not replace
the deployment firewall.
