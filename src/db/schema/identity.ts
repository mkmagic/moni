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
  /** Previous successful login — the gap that `autoSyncOnLogin` measures. */
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
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
    /** TTL backstop; server-side revocation (`revoked_at`) is the primary lever. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
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
