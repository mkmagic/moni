// MCP + domain read surface for households (issue #115, comment 1/E). Through a
// real in-memory MCP client bound to member A's agent token:
//   * whoami surfaces household membership + shared-category names;
//   * household_budget returns the COMBINED figure vs the household ceiling;
//   * household_settlement returns who-owes-whom;
//   * the per-user `spending` tool FLAGS a shared category (the figure there is
//     the member's own spend) and points at household_budget for the combined.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { withUser } from "@/db/client";
import { accounts, entries } from "@/db/schema";
import { encText } from "@/domain/fields";
import { createUser } from "@/domain/registration";
import { updateProfile } from "@/domain/profile";
import { mintToken } from "@/domain/agent-token";
import { createCategory } from "@/domain/categorization";
import { acceptInvite, createHousehold, inviteMember } from "@/domain/household";
import {
  createSharedCategory,
  mapLocalCategory,
  setHouseholdCeiling,
  setSplit,
} from "@/domain/shared-categories";
import { publishSharedTotals } from "@/domain/household-publish";
import { buildAgentMcpServer } from "@/lib/mcp/server";
import type { AgentRequestContext } from "@/lib/mcp/agent-request";
import type { Session } from "@/lib/auth/session-store";
import { cleanupHouseholds, cleanupOwners } from "./helpers";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN;
const MONTH = "2026-08";

let userA: string;
let dkA: Buffer;
let userB: string;
let dkB: Buffer;
let ctxA: AgentRequestContext;
let householdId: string;

async function connect(ctx: AgentRequestContext) {
  const server = await buildAgentMcpServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  async function call(name: string, args: Record<string, unknown> = {}) {
    const res = await client.callTool({ name, arguments: args });
    const content = res.content as Array<{ type: string; text: string }>;
    return JSON.parse(content[1].text) as Record<string, unknown>;
  }
  return { call, close: async () => (await client.close(), await server.close()) };
}

async function seedSpend(userId: string, dataKey: Buffer, categoryId: string, amount: string) {
  const acctId = randomUUID();
  const entryId = randomUUID();
  await withUser(userId, async (tx) => {
    await tx.insert(accounts).values({
      id: acctId,
      ownerId: userId,
      accountType: "checking",
      classification: "asset",
      nameCt: encText(dataKey, "Checking", acctId, "name_ct", 1),
      currency: "ILS",
    });
    await tx.insert(entries).values({
      id: entryId,
      ownerId: userId,
      accountId: acctId,
      entryType: "transaction",
      date: `${MONTH}-08`,
      descriptionCt: encText(dataKey, "Shop", entryId, "description_ct", 1),
      categoryId,
      status: "posted",
      enteredAmountCt: encText(dataKey, amount, entryId, "entered_amount_ct", 1),
      enteredCurrency: "ILS",
      accountAmountCt: encText(dataKey, amount, entryId, "account_amount_ct", 1),
      accountCurrency: "ILS",
      reportingCurrency: "ILS",
      fxRate: "1",
      fxStatus: "locked",
      source: "manual",
    });
  });
}

beforeAll(async () => {
  ({ userId: userA, dataKey: dkA } = await createUser(
    `mcp-a-${randomUUID()}@test.moni`,
    Buffer.from("pw-a"),
    SIGNUP_TOKEN!,
  ));
  ({ userId: userB, dataKey: dkB } = await createUser(
    `mcp-b-${randomUUID()}@test.moni`,
    Buffer.from("pw-b"),
    SIGNUP_TOKEN!,
  ));
  await updateProfile(userA, { agentAccessEnabled: true });
  const { tokenId } = await mintToken(userA, dkA);
  ctxA = { userId: userA, tokenId, dataKey: dkA };

  const sessionA = {
    id: randomUUID(),
    userId: userA,
    dataKey: dkA,
    baseCurrency: "ILS",
  } as Session;
  const sessionB = {
    id: randomUUID(),
    userId: userB,
    dataKey: dkB,
    baseCurrency: "ILS",
  } as Session;
  const catA = await createCategory(sessionA, {
    name: "Groceries",
    parentId: null,
    classification: "expense",
    color: "chart-1",
    icon: "tag",
  });
  const catB = await createCategory(sessionB, {
    name: "Groceries",
    parentId: null,
    classification: "expense",
    color: "chart-1",
    icon: "tag",
  });

  ({ householdId } = await createHousehold(userA, dkA, "Home"));
  const invite = await inviteMember(userA, dkA, householdId);
  await acceptInvite(userB, dkB, invite.secret);
  const { sharedCategoryId } = await createSharedCategory(userA, householdId, "Groceries");
  await mapLocalCategory(userA, householdId, sharedCategoryId, catA);
  await mapLocalCategory(userB, householdId, sharedCategoryId, catB);
  await setSplit(userA, householdId, sharedCategoryId, [
    { memberId: userA, weight: "0.5" },
    { memberId: userB, weight: "0.5" },
  ]);
  await setHouseholdCeiling(userA, dkA, householdId, sharedCategoryId, "1000", MONTH, false);

  await seedSpend(userA, dkA, catA, "-300");
  await seedSpend(userB, dkB, catB, "-500");
  await publishSharedTotals(userB, dkB, [MONTH]);
});

afterAll(async () => {
  await cleanupHouseholds([householdId]);
  await cleanupOwners([userA, userB]);
});

describe("MCP household surface", () => {
  it("whoami surfaces household membership + shared lines", async () => {
    const { call, close } = await connect(ctxA);
    try {
      const who = await call("whoami");
      const households = who.households as Array<{
        name: string;
        memberCount: number;
        sharedCategories: string[];
      }>;
      expect(households).toHaveLength(1);
      expect(households[0].name).toBe("Home");
      expect(households[0].memberCount).toBe(2);
      expect(households[0].sharedCategories).toContain("Groceries");
    } finally {
      await close();
    }
  });

  it("household_budget returns the combined figure vs the household ceiling", async () => {
    const { call, close } = await connect(ctxA);
    try {
      const res = (await call("household_budget", { month: MONTH })) as {
        households: Array<{
          provisional: boolean;
          categories: Array<{ combined: string; ceiling: string; myFigure: string }>;
        }>;
      };
      const cat = res.households[0].categories[0];
      expect(res.households[0].provisional).toBe(false);
      expect(cat.combined).toBe("800");
      expect(cat.ceiling).toBe("1000");
      expect(cat.myFigure).toBe("300");
    } finally {
      await close();
    }
  });

  it("household_settlement returns who-owes-whom", async () => {
    const { call, close } = await connect(ctxA);
    try {
      const res = (await call("household_settlement", { month: MONTH })) as {
        households: Array<{ transfers: Array<{ from: string; to: string; amount: string }> }>;
      };
      expect(res.households[0].transfers).toEqual([{ from: userA, to: userB, amount: "100.00" }]);
    } finally {
      await close();
    }
  });

  it("the per-user spending tool flags a shared category", async () => {
    const { call, close } = await connect(ctxA);
    try {
      const res = (await call("spending", {
        group_by: "category",
        from: `${MONTH}-01`,
        to: `${MONTH}-28`,
      })) as {
        groups: Array<{ label: string; shared?: boolean }>;
        sharedNote?: string;
      };
      const grocery = res.groups.find((g) => g.label === "Groceries")!;
      expect(grocery.shared).toBe(true);
      expect(res.sharedNote).toBeTruthy();
    } finally {
      await close();
    }
  });
});
