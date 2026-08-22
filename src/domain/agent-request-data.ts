// Domain read: the per-request lookups the MCP tool schemas are built from
// (issue #113 Phase 3). Kept in the domain layer — like every other DB read on
// the agent surface — so src/lib/mcp/server.ts never touches tables or the
// field cipher directly (CLAUDE.md "one access path").
//
// The merchant name→id map decrypts Tier-1 merchant names, so it is built
// inside the caller's DK window and never cached in plaintext.
import { eq } from "drizzle-orm";
import { withUser } from "@/db/client";
import { categories, merchants, users } from "@/db/schema";
import { decText } from "@/domain/fields";

export interface AgentRequestData {
  baseCurrency: string;
  /** Category name → id (first wins on a duplicate name). */
  categoryByName: Map<string, string>;
  /** Merchant name → id, decrypted inside the DK window. */
  merchantByName: Map<string, string>;
}

/**
 * Reads the user's base currency and their category/merchant name→id maps,
 * RLS-scoped to `userId`. `dataKey` decrypts the merchant names; it is the
 * caller's Tier-0 buffer and is not wiped here.
 */
export async function loadAgentRequestData(
  userId: string,
  dataKey: Buffer,
): Promise<AgentRequestData> {
  return withUser(userId, async (tx) => {
    const [userRow] = await tx
      .select({ baseCurrency: users.baseCurrency })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const catRows = await tx.select({ id: categories.id, name: categories.name }).from(categories);
    const categoryByName = new Map<string, string>();
    for (const c of catRows) if (!categoryByName.has(c.name)) categoryByName.set(c.name, c.id);

    const merRows = await tx
      .select({ id: merchants.id, nameCt: merchants.nameCt, version: merchants.version })
      .from(merchants);
    const merchantByName = new Map<string, string>();
    for (const m of merRows) {
      const name = decText(dataKey, m.nameCt, m.id, "name_ct", m.version);
      if (name && !merchantByName.has(name)) merchantByName.set(name, m.id);
    }

    return { baseCurrency: userRow?.baseCurrency ?? "ILS", categoryByName, merchantByName };
  });
}
