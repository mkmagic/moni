// Zod at the trust boundary (docs/design/conventions.md — Validation),
// shared by POST /api/rules and PATCH /api/rules/[id].
//
// The operator set is closed on purpose and contains no regex: rule values
// are user-authored, but the descriptions they run against are untrusted
// scraper output, so a regex engine on that path would be a ReDoS surface
// for no real gain (docs/design/categorization.md).
import { z } from "zod";

const LeafConditionSchema = z.discriminatedUnion("conditionType", [
  z.object({
    conditionType: z.literal("description"),
    operator: z.enum(["contains", "starts_with", "equals"]),
    value: z.string().min(1).max(200),
  }),
  z.object({
    conditionType: z.literal("amount"),
    operator: z.enum(["gt", "lt", "eq"]),
    // Decimal string, never a JS number — money never widens to a float.
    value: z.string().regex(/^\d+(\.\d+)?$/),
  }),
  z.object({
    conditionType: z.literal("account"),
    operator: z.literal("eq"),
    value: z.uuid(),
  }),
]);

/** Top level allows one `group`, whose children must be leaves — exactly the
 * schema's one nesting level (data-model.md §5). */
const ConditionSchema = z.union([
  LeafConditionSchema,
  z.object({
    conditionType: z.literal("group"),
    operator: z.enum(["all", "any"]),
    value: z.literal(""),
    children: z.array(LeafConditionSchema).min(1).max(5),
  }),
]);

export const RuleBodySchema = z.object({
  name: z.string().min(1).max(120),
  active: z.boolean(),
  effectiveDate: z.iso.date().nullable(),
  categoryId: z.uuid(),
  conditions: z.array(ConditionSchema).min(1).max(5),
});

/** PATCH may carry only `active`, for the row toggle. */
export const RulePatchSchema = z.union([
  RuleBodySchema,
  z.object({ active: z.boolean() }).strict(),
]);
