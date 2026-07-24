// Zod schemas for every trust boundary (API input, MCP tool arguments,
// scraper output, LLM output) land here (T4). See docs/design/conventions.md.
//
// Scope is intentionally minimal right now: there is no domain layer or API
// yet to validate against (connector-interface.md is still a stub), so this
// only covers what T5/T6 concretely need today. Expand as real trust
// boundaries are built — don't add speculative schemas ahead of them.
import { z } from "zod";
import { DECIMAL_STRING_PATTERN } from "@/lib/money";

/** The `Money` shape (src/lib/money) at a trust boundary. */
export const moneySchema = z.object({
  amount: z.string().regex(DECIMAL_STRING_PATTERN, "must be a canonical decimal string"),
  currency: z
    .string()
    .length(3)
    .regex(/^[A-Z]{3}$/, "must be a 3-letter uppercase currency code"),
});

/** The AAD context (src/lib/crypto) that binds a ciphertext to its row/column/version. */
export const aadContextSchema = z.object({
  rowId: z.uuid(),
  column: z.string().min(1),
  version: z.int().positive(),
});
