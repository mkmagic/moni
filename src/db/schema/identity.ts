import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  jsonb,
  boolean,
  timestamp,
  unique,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { bytea, timestamps } from "./shared";

/**
 * Auth-adjacent tables (`sessions`, `api_keys`, WebAuthn credentials) are
 * owned by the future domain-layer/MCP design and intentionally not defined
 * here (data-model.md §5). Key custody itself lives on `userUnlockMethods`
 * below, not on this table — `users` carries only identity + preference
 * columns.
 */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  // Identity/preference only — plaintext like `email`, deliberately NOT a
  // Tier-1 encrypted field. A display name carries no financial information;
  // the encrypted set is amounts, descriptions, account numbers, holdings and
  // credentials (CLAUDE.md invariants).
  displayName: text("display_name"),
  baseCurrency: text("base_currency").notNull().default("ILS"),
  /** Opt-in: offer to sync connections at login after a long gap. The column
   * name predates the term — this is the "sync reminder" of CONTEXT.md, and
   * it never syncs anything on its own. */
  autoSyncOnLogin: boolean("auto_sync_on_login").notNull().default(false),
  /** Opt-in: send unrecognized merchant names to an LLM model to suggest categories. */
  smartCategorize: boolean("smart_categorize").notNull().default(false),
  /** Opt-in: allow this user's own agent tokens (MCP) to read their data
   * headless (issue #113 Phase 5). Off is the master kill switch — while it is
   * false, `verifyAndUnwrapDk` fails closed for every one of this user's
   * tokens, and no new token can be minted. Per-user: enabling it never touches
   * anyone else's DK. */
  agentAccessEnabled: boolean("agent_access_enabled").notNull().default(false),
  /** Previous successful login — the gap that `autoSyncOnLogin` measures. */
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  /** When the user first finished or dismissed the guided product tour. NULL
   * means they've never seen it, which is the only signal the dashboard's
   * first-run prompt reads; replaying the tour from Settings never clears it.
   * Identity/preference plaintext like the columns above — carries no financial
   * information. */
  tourSeenAt: timestamp("tour_seen_at", { withTimezone: true }),
  ...timestamps,
});

export const unlockMethodTypeEnum = pgEnum("unlock_method_type", [
  "password-argon2id",
  "webauthn-prf",
  "recovery-code",
]);

/**
 * One row per unlock factor (docs/security/threat-model.md §5). A row wraps
 * the per-user data key (DK — Tier-1 field reads), the credential key (CK —
 * Tier-0 bank-credential reads), or one of the two, under that factor's
 * key-encryption-key — so enrolling or re-keying a factor only ever re-wraps
 * 32 opaque bytes, never decrypts-and-re-encrypts a user's actual data.
 *
 * **Which keys a row opens is recorded by which wrap column is non-null**
 * (issue #7's decision, inheriting the requirement from #18). No row wraps
 * both today, and the split is the point rather than an accident:
 *
 *   * `password-argon2id` wraps DK only. The login password is structurally
 *     incapable of reaching CK, which is what removes the whole class of
 *     "prompt the user for their Moni password and harvest it" attacks
 *     against a future AI-agent surface.
 *   * `webauthn-prf` wraps CK only. Bank credentials are reachable only via
 *     a passkey's origin-bound, non-replayable PRF output.
 *   * `recovery-code` (not implemented) would wrap DK only. There is
 *     deliberately NO recovery path for CK: lose every enrolled passkey and
 *     you re-enter your bank logins.
 *
 * The AAD for each wrapped column binds to *this row's* id, not `users.id`
 * (docs/design/encryption.md §3) — every other ciphertext column in the
 * schema binds to its own storing row, and this table is no exception.
 */
export const userUnlockMethods = pgTable(
  "user_unlock_methods",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    type: unlockMethodTypeEnum("type").notNull(),
    wrappedDataKey: bytea("wrapped_data_key"),
    wrappedCredentialKey: bytea("wrapped_credential_key"),
    // Public, non-secret unlock parameters — `{ saltB64, params }` for the
    // password method, `{ credentialIdB64Url, publicKeyB64Url, counter, rpId,
    // … }` for a WebAuthn-PRF passkey. Never the plaintext key material
    // itself, and never the PRF output.
    unlockRef: jsonb("unlock_ref").notNull(),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    unique("user_unlock_methods_owner_id_id_unique").on(table.ownerId, table.id),
    // At most one password method per user (docs plan §A2).
    uniqueIndex("user_unlock_methods_one_password_per_owner")
      .on(table.ownerId)
      .where(sql`${table.type} = 'password-argon2id'`),
  ],
);

/**
 * Per-user **agent tokens** — the bearer secret a remote MCP client carries to
 * read that user's own financial data headless (issue #113, docs/design/
 * mcp-and-api.md §4). One row per minted token, RLS-scoped to its owner.
 *
 * The token is opaque and **hashed at rest** — `token_hash` is the SHA-256 of
 * the secret, never the secret itself; the plaintext is shown to the user
 * exactly once at mint time and stored only by the client. `wrapped_dk` holds
 * the user's data key (DK) re-wrapped under a KEK derived from the token
 * secret (the same 32-byte-secret→KEK seam `webauthn-prf` uses for CK), so a
 * request bearing the token can unwrap DK for that one request and nothing
 * else. Neither column is usable without the secret, which is why the pre-auth
 * lookup policy that finds a row by `token_hash` before `app.user_id` is known
 * is safe — mirroring `users_app_select` (drizzle/0002).
 *
 * **DK only, never CK.** There is deliberately no credential-key column here:
 * the two-key boundary (docs/design/mcp-and-api.md §3) is that an agent token
 * can disclose Tier-1 financial data but can never reach the bank-credential
 * key. That boundary is structural — this table cannot hold a CK wrap.
 */
export const agentTokens = pgTable(
  "agent_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    // SHA-256 of the opaque token secret. High-entropy, so an equality lookup
    // needs no constant-time compare (unlike a low-entropy secret).
    tokenHash: bytea("token_hash").notNull(),
    // DK wrapped under a KEK derived from the token secret. Opaque ciphertext.
    wrappedDk: bytea("wrapped_dk").notNull(),
    label: text("label"),
    /** TTL backstop; server-side revocation (`revoked_at`) is the primary lever.
     * NULL means no expiry ("never") — the user's explicit choice; revocation
     * and the per-user opt-in kill switch remain the controls. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique("agent_tokens_owner_id_id_unique").on(table.ownerId, table.id),
    // The pre-auth lookup key: verify resolves a presented token to its row by
    // hash before any user is scoped in.
    uniqueIndex("agent_tokens_token_hash_unique").on(table.tokenHash),
  ],
);

/**
 * **Agent access log** — one row per agent-token tool call (issue #113 Phase 4,
 * docs/design/mcp-and-api.md §7, threat-model §9). This is the visibility that
 * makes an anomalous whole-ledger sweep detectable, and the source the
 * per-token rate cap counts against — an appended row is a call that happened.
 *
 * **Never plaintext.** A row records what was *asked*, not what was returned:
 * the tool name, the *shape* of the arguments (`arg_shape` is a `{key: jsType}`
 * map — never argument *values*, since a category/merchant filter value would
 * be Tier-1 plaintext), and how many rows the call yielded. No amount,
 * description, counterparty, or secret is ever written here.
 *
 * RLS-scoped to `owner_id` like any user-owned table. Unlike `agent_tokens` it
 * needs no pre-auth policy: every write and read happens inside `withUser`
 * (the owner is already resolved by the time a tool runs), so the standard
 * tenant-isolation policy is the whole story.
 */
export const agentAccessLog = pgTable(
  "agent_access_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    // The token whose call this was. Cascades so an account deletion that drops
    // agent_tokens also drops its log rows without a manual ordering step.
    tokenId: uuid("token_id").references(() => agentTokens.id, { onDelete: "cascade" }),
    // OAuth calls are attributed to the long-lived grant instead. Exactly one
    // credential FK is present on every row (enforced below), so rate caps and
    // audit visibility remain per credential across both auth ceremonies.
    oauthGrantId: uuid("oauth_grant_id").references(() => mcpOauthGrants.id, {
      onDelete: "cascade",
    }),
    tool: text("tool").notNull(),
    // `{ argName: "string" | "number" | "boolean" | ... }` — key presence and
    // JS type only. NEVER the argument values (an enum value would be Tier-1).
    argShape: jsonb("arg_shape").notNull(),
    rowCount: integer("row_count").notNull(),
    ...timestamps,
  },
  (table) => [
    unique("agent_access_log_owner_id_id_unique").on(table.ownerId, table.id),
    check(
      "agent_access_log_one_credential_check",
      sql`num_nonnulls(${table.tokenId}, ${table.oauthGrantId}) = 1`,
    ),
    // The rate-cap query key: count a token's recent calls (token_id, time).
    index("agent_access_log_token_id_created_at_idx").on(table.tokenId, table.createdAt),
    index("agent_access_log_oauth_grant_id_created_at_idx").on(table.oauthGrantId, table.createdAt),
  ],
);

/**
 * Per-user **OAuth grants** — one row per (user, connected supported client)
 * pair from the OAuth 2.1 authorization-code flow that lets Claude or ChatGPT
 * reach `/api/mcp` (issue #113 OAuth phase, docs/design/mcp-and-api.md).
 * RLS-scoped to its owner exactly like `agent_tokens`.
 *
 * This table stores **both token envelopes** — the long-lived refresh envelope
 * and the short-lived access envelope. Access tokens are opaque bearer secrets
 * (like `agent_tokens`), NOT self-contained: the `access_wrapped_dk` that a
 * token's secret unwraps lives HERE, never in the token string. That is the
 * whole point — a token holder cannot recover DK offline, and `revoked_at` /
 * `access_expires_at` on this row are the only things that let a request open
 * DK. (The earlier stateless design packed `wrapped_dk` into the token itself,
 * which let any holder extract DK offline and keep it past expiry/revocation —
 * a standing key, exactly what threat-model §5.6 forbids.)
 *
 * `refresh_wrapped_dk` / `access_wrapped_dk` are the user's data key (DK)
 * re-wrapped under a KEK derived from the current refresh / access secret — the
 * same 32-byte-secret→KEK seam `agent_tokens`/`webauthn-prf` use. The refresh
 * secret rotates on every refresh (RFC 6819 §5.2.2.3); `previous_refresh_token_hash`
 * keeps the immediately-superseded hash so a replay of a rotated-away refresh
 * token is *detected* and revokes the whole grant family (RFC 9700 §4.14). The
 * refresh columns are NULL when the grant was issued without `offline_access` —
 * no refresh token is handed out, so the grant lives only as long as its access
 * token. Neither secret column is usable without the presented secret, which is
 * why the pre-auth SELECT policy that finds a row by hash before `app.user_id`
 * is known is safe — the same shape as `agent_tokens_app_select` (drizzle/0029).
 *
 * `resource` is the RFC 8707 audience the grant is bound to (the MCP server's
 * `${issuer}/api/mcp`); a token is refused if presented to a different resource.
 * NULL means an older grant that predates audience binding (checked leniently).
 *
 * **DK only, never CK.** Like `agent_tokens`, there is deliberately no
 * credential-key column: an OAuth grant can disclose Tier-1 financial data but
 * can never reach the bank-credential key. The boundary is structural.
 *
 * `client_id` is the connecting client's Client ID Metadata Document URL
 * (CIMD — MCP 2025-11-25). The client identifies itself with an HTTPS URL
 * rather than registering dynamically, so there is no clients table: the URL
 * is validated against the Anthropic/OpenAI host allowlist at authorize time
 * and stored here verbatim. Not a secret.
 */
export const mcpOauthGrants = pgTable(
  "mcp_oauth_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    clientId: text("client_id").notNull(),
    // SHA-256 of the current refresh-token secret. Rotates every refresh. NULL
    // when the grant was issued without `offline_access` (no refresh token).
    refreshTokenHash: bytea("refresh_token_hash"),
    // DK wrapped under a KEK derived from the current refresh secret. Opaque
    // ciphertext; re-wrapped on every refresh alongside the hash. NULL alongside
    // `refresh_token_hash` for a no-`offline_access` grant.
    refreshWrappedDk: bytea("refresh_wrapped_dk"),
    // SHA-256 of the *immediately-superseded* refresh secret, kept for one step
    // so a replay of a rotated-away token is detected (RFC 9700 §4.14) and
    // revokes the family. Overwritten on each rotation; NULL before the first.
    previousRefreshTokenHash: bytea("previous_refresh_token_hash"),
    // SHA-256 of the current access-token secret. Rotates on issue/refresh.
    accessTokenHash: bytea("access_token_hash"),
    // DK wrapped under a KEK derived from the current access secret. Opaque
    // ciphertext — the token string carries ONLY the secret, never this.
    accessWrappedDk: bytea("access_wrapped_dk"),
    // Access-token expiry (~1h). The authoritative check is server-side here,
    // not a self-describing field the holder could edit.
    accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }),
    // RFC 8707 audience this grant is bound to (`${issuer}/api/mcp`). NULL for
    // grants that predate audience binding.
    resource: text("resource"),
    scope: text("scope").notNull(),
    label: text("label"),
    /** Refresh/grant expiry backstop; server-side `revoked_at` is the primary
     * lever. NULL means no expiry ("never") — the user's explicit choice,
     * mirroring `agent_tokens`. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique("mcp_oauth_grants_owner_id_id_unique").on(table.ownerId, table.id),
    // The pre-auth lookup keys: /token and every MCP request resolve a presented
    // secret to its row by hash before any user is scoped in. Nullable columns,
    // so these unique indexes permit many NULLs (Postgres treats them distinct).
    uniqueIndex("mcp_oauth_grants_refresh_token_hash_unique").on(table.refreshTokenHash),
    uniqueIndex("mcp_oauth_grants_access_token_hash_unique").on(table.accessTokenHash),
    uniqueIndex("mcp_oauth_grants_previous_refresh_token_hash_unique").on(
      table.previousRefreshTokenHash,
    ),
  ],
);

/**
 * Short-lived **OAuth authorization codes** — the single-use envelope that
 * carries the user's data key (DK) from the interactive `/authorize` consent
 * step (where a live Moni session has DK in RAM) to the back-channel `/token`
 * exchange (which has no session). This is the crux of preserving the
 * no-server-side-key invariant across the OAuth dance: DK is wrapped here at
 * authorize time and unwrapped exactly once at token time, then re-wrapped into
 * the grant's refresh envelope and the stateless access token.
 *
 * `wrapped_dk` holds DK under a KEK derived from a secret embedded in the code
 * string itself (the same 32-byte-secret→KEK seam the rest of the system uses).
 * The row is useless without that secret, which travels only in the redirect to
 * the legitimate client — so the pre-auth SELECT policy that finds a row by
 * `code_hash` before `app.user_id` is known is safe (mirrors
 * `agent_tokens_app_select`, drizzle/0029).
 *
 * `code_challenge` is the PKCE S256 challenge (RFC 7636); `/token` requires a
 * `code_verifier` whose SHA-256 matches it. `consumed_at` enforces single use
 * (OAuth 2.1) — a second exchange of the same code is refused. Codes are
 * ultra-short-lived (`expires_at`, ~60s), so unlike grants there is no
 * "never" expiry: the column is NOT NULL.
 *
 * **DK only, never CK** — structurally, like every other envelope on the agent
 * surface: no credential-key column exists here.
 */
export const mcpOauthAuthCodes = pgTable(
  "mcp_oauth_auth_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    // The connecting client's CIMD URL — carried through to the grant on
    // exchange, and re-validated against the redirect_uri at /token.
    clientId: text("client_id").notNull(),
    // SHA-256 of the code secret. The pre-auth lookup key at /token.
    codeHash: bytea("code_hash").notNull(),
    // DK wrapped under a KEK derived from the code secret. Opaque ciphertext,
    // written once at authorize, unwrapped once at token, then this row dies.
    wrappedDk: bytea("wrapped_dk").notNull(),
    // PKCE S256 challenge (base64url). Bound to the client that began the flow.
    codeChallenge: text("code_challenge").notNull(),
    // The redirect_uri the flow began with; re-checked at /token (RFC 6749).
    redirectUri: text("redirect_uri").notNull(),
    // RFC 8707 audience the client requested at /authorize; carried onto the
    // grant at exchange. NULL when the client sent no `resource`.
    resource: text("resource"),
    scope: text("scope").notNull(),
    // Always dated (~60s out) — an auth code has no "never" lifetime.
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // Single-use marker (OAuth 2.1): set on first exchange; a second is refused.
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique("mcp_oauth_auth_codes_owner_id_id_unique").on(table.ownerId, table.id),
    // The pre-auth lookup key: /token resolves a presented code to its row by
    // hash before any user is scoped in.
    uniqueIndex("mcp_oauth_auth_codes_code_hash_unique").on(table.codeHash),
  ],
);
