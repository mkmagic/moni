import { pgTable, uuid, text, jsonb } from "drizzle-orm/pg-core";
import { bytea, timestamps } from "./shared";

/**
 * Auth-adjacent tables (`sessions`, `api_keys`, WebAuthn credentials) are
 * owned by the future domain-layer/MCP design and intentionally not defined
 * here (data-model.md §5). Only `users` lands with this migration.
 *
 * Key-custody columns are stubs: the real key hierarchy (wrapped data key,
 * unlock/WebAuthn credential references, recovery-code hashes) is pinned by
 * the security-foundation work (threat-model.md §5, §10), not this schema.
 * They are typed loosely and nullable so a user row can exist before
 * key-custody setup runs.
 */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  baseCurrency: text("base_currency").notNull().default("ILS"),
  // Stub: the per-user data key, wrapped by the unlock secret. Real
  // wrapping scheme TBD by the security-foundation work.
  wrappedDataKey: bytea("wrapped_data_key"),
  // Stub: opaque reference to the user's unlock method (WebAuthn credential
  // id, password-KDF params, etc.) — shape not yet pinned.
  unlockMethodRef: jsonb("unlock_method_ref"),
  // Stub: hashes of one-time recovery codes (threat-model.md §10). Never the
  // plaintext codes themselves.
  recoveryCodeHashes: jsonb("recovery_code_hashes"),
  ...timestamps,
});
