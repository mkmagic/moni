// Zod at the trust boundary (docs/design/conventions.md — Validation),
// shared by POST /api/categories and PATCH /api/categories/[id].
//
// Shape only. The icon and color allowlists are deliberately NOT restated
// here: the domain layer checks them against
// `category-icons.ts` / `default-categories.ts`, and a second copy of a
// 70-name list is a second thing to keep in step. A value outside the
// allowlist raises `InvalidCategoryNestingError`, which these handlers turn
// into a 400 just as a schema failure would.
import { z } from "zod";

export const CategoryBodySchema = z.object({
  name: z.string().min(1).max(60),
  parentId: z.uuid().nullable(),
  classification: z.enum(["income", "expense", "transfer"]),
  color: z.string().min(1).max(40),
  icon: z.string().min(1).max(40),
});
