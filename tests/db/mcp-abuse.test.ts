// MCP abuse + injection posture (issue #113 Phase 4, docs/design/mcp-and-api.md
// §7, threat-model §9). Three properties:
//   * every tool call appends ONE audit row (tool + arg *shape* + row count);
//   * that row carries NO plaintext — a merchant filter value never lands in
//     the log, only its type;
//   * a runaway sweep trips the per-token rate cap (returned as a tool error,
//     the token stays valid).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { withUser } from "@/db/client";
import * as schema from "@/db/schema";
import { createUser } from "@/domain/registration";
import { updateProfile } from "@/domain/profile";
import { mintToken } from "@/domain/agent-token";
import { encText } from "@/domain/fields";
import {
  AgentAccessCapError,
  RATE_CAP_PER_MINUTE,
  assertUnderRateCap,
} from "@/domain/agent-access-log";
import { buildAgentMcpServer } from "@/lib/mcp/server";
import type { AgentRequestContext } from "@/lib/mcp/agent-request";
import { elevatedDb, cleanupOwners } from "./helpers";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN;
if (!SIGNUP_TOKEN) {
  throw new Error("MONI_SIGNUP_TOKEN must be set in the test environment (see .env.example)");
}

const MERCHANT_NAME = "Shufersal-סופרסל";

describe("MCP abuse + injection posture (issue #113 Phase 4)", () => {
  const createdUserIds: string[] = [];
  afterAll(async () => cleanupOwners(createdUserIds));

  async function fixture(label: string): Promise<AgentRequestContext & { accountId: string }> {
    const email = `${label}-${randomUUID()}@test.moni`;
    const { userId, dataKey } = await createUser(
      email,
      Buffer.from("correct horse battery staple", "utf8"),
      SIGNUP_TOKEN!,
    );
    createdUserIds.push(userId);
    await updateProfile(userId, { agentAccessEnabled: true });
    const { tokenId } = await mintToken(userId, dataKey);

    const accountId = randomUUID();
    await elevatedDb.insert(schema.accounts).values({
      id: accountId,
      ownerId: userId,
      nameCt: encText(dataKey, "Checking", accountId, "name_ct", 1),
      accountType: "checking",
      classification: "asset",
      currency: "ILS",
      currentBalanceCt: encText(dataKey, "1000", accountId, "current_balance_ct", 1),
      status: "active",
    });
    const merchantId = randomUUID();
    await elevatedDb.insert(schema.merchants).values({
      id: merchantId,
      ownerId: userId,
      nameCt: encText(dataKey, MERCHANT_NAME, merchantId, "name_ct", 1),
      matchTextCt: encText(dataKey, MERCHANT_NAME.toLowerCase(), merchantId, "match_text_ct", 1),
    });
    const entryId = randomUUID();
    await elevatedDb.insert(schema.entries).values({
      id: entryId,
      ownerId: userId,
      accountId,
      entryType: "transaction",
      date: "2026-03-05",
      descriptionCt: encText(dataKey, "Purchase", entryId, "description_ct", 1),
      merchantId,
      status: "posted",
      enteredAmountCt: encText(dataKey, "-100", entryId, "entered_amount_ct", 1),
      enteredCurrency: "ILS",
      accountAmountCt: encText(dataKey, "-100", entryId, "account_amount_ct", 1),
      accountCurrency: "ILS",
      reportingCurrency: "ILS",
      fxRate: "1",
      fxRateDate: "2026-03-05",
      fxSource: "identity",
      fxStatus: "locked",
      source: "manual",
    });

    return { userId, tokenId, dataKey, accountId };
  }

  async function connect(ctx: AgentRequestContext) {
    const server = await buildAgentMcpServer(ctx);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    return {
      call: (name: string, args: Record<string, unknown> = {}) =>
        client.callTool({ name, arguments: args }),
      close: async () => {
        await client.close();
        await server.close();
      },
    };
  }

  it("writes one audit row per call — arg shape and row count only, never a value", async () => {
    const ctx = await fixture("abuse-audit");
    const mcp = await connect(ctx);
    try {
      await mcp.call("transactions", { merchant: MERCHANT_NAME, limit: 5 });
    } finally {
      await mcp.close();
    }

    const rows = await withUser(ctx.userId, (tx) =>
      tx.select().from(schema.agentAccessLog).where(eq(schema.agentAccessLog.tokenId, ctx.tokenId)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].tool).toBe("transactions");
    expect(rows[0].rowCount).toBe(1); // the one seeded entry
    // Arg SHAPE: keys→types, never values.
    expect(rows[0].argShape).toEqual({ merchant: "string", limit: "number" });
    // The load-bearing rule: no plaintext anywhere in the row.
    expect(JSON.stringify(rows[0])).not.toContain(MERCHANT_NAME);
    expect(JSON.stringify(rows[0])).not.toContain("סופרסל");
  });

  it("trips the per-token rate cap once the trailing window is full", async () => {
    const ctx = await fixture("abuse-cap");

    // Under the cap: fine.
    await expect(assertUnderRateCap(ctx.userId, ctx.tokenId)).resolves.toBeUndefined();

    // Fill the window to the per-minute cap with recent rows.
    const now = new Date();
    await elevatedDb.insert(schema.agentAccessLog).values(
      Array.from({ length: RATE_CAP_PER_MINUTE }, () => ({
        ownerId: ctx.userId,
        tokenId: ctx.tokenId,
        tool: "spending",
        argShape: {},
        rowCount: 0,
        createdAt: now,
      })),
    );

    await expect(assertUnderRateCap(ctx.userId, ctx.tokenId)).rejects.toBeInstanceOf(
      AgentAccessCapError,
    );

    // And through the tool surface: the next call comes back as a tool error,
    // not a thrown request — the token itself is still valid.
    const mcp = await connect(ctx);
    try {
      const res = await mcp.call("whoami");
      expect(res.isError).toBe(true);
      const text = (res.content as Array<{ text: string }>)[0].text;
      expect(text).toContain("Rate limit");
    } finally {
      await mcp.close();
    }

    // No new audit row was written for the rejected call — a rejection is not a
    // call that counts against the window (which would deadlock re-opening).
    const [{ n }] = await withUser(ctx.userId, (tx) =>
      tx
        .select({ n: schema.agentAccessLog.id })
        .from(schema.agentAccessLog)
        .where(
          and(
            eq(schema.agentAccessLog.tokenId, ctx.tokenId),
            eq(schema.agentAccessLog.tool, "whoami"),
          ),
        ),
    ).then((r) => [{ n: r.length }]);
    expect(n).toBe(0);
  });
});
