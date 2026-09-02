// Attribute locking — the mechanism that stops automation from overwriting a
// human's correction (vision.md; docs/design/domain-layer.md §3.2).
//
// `entries.locked_attributes` is a plaintext JSONB map of FIELD NAME -> true.
// Names only, never values (data-model.md §2): the applied value and who
// applied it live in `entry_field_changelog`, which is append-only and
// AAD-binds its ciphertext to its own row. Storing a timestamp here instead
// (as Maybe does) would just duplicate `entry_field_changelog.created_at`.
//
// The rule the whole pipeline rests on: once a user sets a field, every
// later rule and model pass must skip THAT FIELD and let the rest of the
// payload through. Only the user can clear the lock.

/** Fields that can be locked. `date` joins `category_id` because a user can
 * correct a transaction's date by hand, and a later scrape must not revert it
 * (the pending -> posted re-date in sync-promotion.ts). */
export type LockableField = "category_id" | "date";

export type LockedAttributes = Partial<Record<LockableField, true>>;

/**
 * Narrows the `jsonb` column (typed `unknown` by Drizzle) to the lock map.
 * Anything unexpected in the column reads as "nothing locked" rather than
 * throwing — a malformed map must not be able to wedge a whole sync.
 */
export function parseLockedAttributes(raw: unknown): LockedAttributes {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: LockedAttributes = {};
  const map = raw as Record<string, unknown>;
  if (map.category_id === true) out.category_id = true;
  if (map.date === true) out.date = true;
  return out;
}

export function isFieldLocked(raw: unknown, field: LockableField): boolean {
  return parseLockedAttributes(raw)[field] === true;
}

/** Returns the map to write when a user sets `field`. */
export function withFieldLocked(raw: unknown, field: LockableField): LockedAttributes {
  return { ...parseLockedAttributes(raw), [field]: true };
}

/** Returns the map to write when a user clears `field`, releasing it back to
 * automation. */
export function withFieldUnlocked(raw: unknown, field: LockableField): LockedAttributes {
  const next = parseLockedAttributes(raw);
  delete next[field];
  return next;
}
