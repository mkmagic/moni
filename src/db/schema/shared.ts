import { customType, timestamp } from "drizzle-orm/pg-core";

/**
 * Tier-0/Tier-1 sensitive values are stored as opaque ciphertext — nonce +
 * AEAD output produced and consumed only by the app-tier crypto module
 * (docs/design/encryption.md). Drizzle has no built-in `bytea` column type,
 * so this defines one on top of Postgres `bytea`; node-postgres already
 * maps `bytea` to/from a Node `Buffer` natively, so no custom
 * toDriver/fromDriver mapping is needed.
 */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * `created_at` / `updated_at`, carried by every table (data-model.md §2).
 * `entry_field_changelog` is the sole documented exception (append-only, no
 * `updated_at`) and defines its own `created_at` instead of spreading this.
 */
export const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};
