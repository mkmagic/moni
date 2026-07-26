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
  /** Opt-in: offer to sync connections at login after a long gap. */
  autoSyncOnLogin: boolean("auto_sync_on_login").notNull().default(false),
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
 * One row per unlock factor (docs/security/threat-model.md §5). Each row
 * independently wraps BOTH the per-user data key (DK — Tier-1 field reads)
 * and credential key (CK — Tier-0 bank-credential reads) under that
 * factor's key-encryption-key, so a password change (or a future passkey/
 * recovery-code enrollment) only ever re-wraps 32 opaque bytes twice, never
 * decrypts-and-re-encrypts a user's actual data. Only `password-argon2id` is
 * implemented in v1.0; the shape supports "insert another row" for
 * WebAuthn-PRF and recovery codes without a later migration over live
 * Tier-0 columns.
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
    wrappedDataKey: bytea("wrapped_data_key").notNull(),
    wrappedCredentialKey: bytea("wrapped_credential_key").notNull(),
    // Public, non-secret unlock parameters (e.g. { saltB64, params } for the
    // password method) — never the plaintext key material itself.
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
