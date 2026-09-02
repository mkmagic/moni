// Request schemas for the household-sharing API (issue #115). The domain layer
// is the real gate — it enforces membership, split-sums-to-1, and decimal
// canonicality — so these schemas only shape the request and reject obvious
// junk before it reaches a domain call.
import { z } from "zod";

/** Canonical non-negative decimal string (money/weight). The domain re-checks. */
const DECIMAL = /^\d+(\.\d+)?$/;
/** "YYYY-MM" or "YYYY-MM-DD" — the effective-from month for a ceiling. */
const MONTH = /^\d{4}-(0[1-9]|1[0-2])(-\d{2})?$/;

export const CreateHouseholdSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

/** Invite lifetimes offered in the UI → ttlMs (never = no expiry). */
export const INVITE_TTL_MS: Record<string, number | null> = {
  "1d": 24 * 60 * 60 * 1000,
  "1w": 7 * 24 * 60 * 60 * 1000,
  "1m": 30 * 24 * 60 * 60 * 1000,
  never: null,
};

export const InviteSchema = z.object({
  householdId: z.uuid(),
  inviteeEmail: z.string().trim().email().max(320).optional(),
  ttl: z.enum(["1d", "1w", "1m", "never"]).optional(),
});

export const JoinSchema = z.object({
  // The invite secret is an opaque prefixed string; the domain validates its
  // shape and authenticity, so only require that something was sent.
  secret: z.string().trim().min(1).max(256),
});

export const CreateSharedCategorySchema = z.object({
  householdId: z.uuid(),
  name: z.string().trim().min(1).max(80),
  isRecurring: z.boolean().optional(),
});

/** One PATCH on a shared category, discriminated by `op`. `memberId` is a user
 * id (not necessarily a UUID shape we want to over-police), so it stays a plain
 * string the domain checks against the real roster. */
export const SharedCategoryPatchSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("split"),
    householdId: z.uuid(),
    weights: z
      .array(z.object({ memberId: z.string().min(1), weight: z.string().regex(DECIMAL) }))
      .min(1),
  }),
  z.object({
    op: z.literal("ceiling"),
    householdId: z.uuid(),
    amount: z.string().regex(DECIMAL),
    effectiveFrom: z.string().regex(MONTH),
    rollover: z.boolean(),
  }),
  z.object({
    op: z.literal("map"),
    householdId: z.uuid(),
    localCategoryId: z.uuid(),
  }),
  z.object({
    op: z.literal("unmap"),
    householdId: z.uuid(),
    localCategoryId: z.uuid(),
  }),
]);
