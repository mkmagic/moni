// MCP read-only tool surface (issue #113 Phase 3): net_worth (authoritative
// computed), spending (aggregation), transactions (raw-row escape hatch).
//
// The properties under test are the ones #19 and the threat model care about:
//   * aggregate answers MATCH the domain layer (money math never done model-
//     side — the tool returns figures the domain computed with decimal.js);
//   * FX conversion happens in the domain (an entry in a foreign currency is
//     summed at its locked rate, not 1:1);
//   * transfers / excluded / pending-FX entries are handled exactly as the
//     dashboard handles them;
//   * cross-tenant: user A's token cannot read user B through any tool;
//   * every result carries a provenance block naming the identity it ran as.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createUser } from "@/domain/registration";
import { createCategory } from "@/domain/categorization";
import { getOverview } from "@/domain/dashboard";
import { aggregateSpending } from "@/domain/aggregates";
import { encText } from "@/domain/fields";
import { buildAgentMcpServer } from "@/lib/mcp/server";
import type { AgentRequestContext } from "@/lib/mcp/agent-request";
import type { Session } from "@/lib/auth/session-store";
import * as schema from "@/db/schema";
import { elevatedDb, cleanupOwners } from "./helpers";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN;
if (!SIGNUP_TOKEN) {
  throw new Error("MONI_SIGNUP_TOKEN must be set in the test environment (see .env.example)");
}

interface Fixture {
  userId: string;
  dataKey: Buffer;
  session: Session;
  ctx: AgentRequestContext;
  accountId: string;
}

const createdUserIds: string[] = [];
afterAll(async () => cleanupOwners(createdUserIds));

async function freshFixture(label: string): Promise<Fixture> {
  const email = `${label}-${randomUUID()}@test.moni`;
  const { userId, dataKey } = await createUser(
    email,
    Buffer.from("correct horse battery staple", "utf8"),
    SIGNUP_TOKEN!,
  );
  createdUserIds.push(userId);
  const session = { id: randomUUID(), userId, dataKey, baseCurrency: "ILS" } as Session;

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

  return { userId, dataKey, session, ctx: { userId, dataKey }, accountId };
}

async function category(
  fx: Fixture,
  name: string,
  classification: "expense" | "income" | "transfer",
) {
  return createCategory(fx.session, {
    name: `${name}-${randomUUID().slice(0, 6)}`,
    parentId: null,
    classification,
    color: "chart-1",
    icon: "tag",
  });
}

async function merchant(fx: Fixture, name: string): Promise<string> {
  const id = randomUUID();
  await elevatedDb.insert(schema.merchants).values({
    id,
    ownerId: fx.userId,
    nameCt: encText(fx.dataKey, name, id, "name_ct", 1),
    matchTextCt: encText(fx.dataKey, name.toLowerCase(), id, "match_text_ct", 1),
  });
  return id;
}

async function addEntry(
  fx: Fixture,
  opts: {
    date: string;
    amount: string;
    currency?: string;
    fxRate?: string | null;
    fxStatus?: "locked" | "pending";
    categoryId?: string | null;
    merchantId?: string | null;
    excluded?: boolean;
  },
): Promise<void> {
  const id = randomUUID();
  const currency = opts.currency ?? "ILS";
  const fxStatus = opts.fxStatus ?? "locked";
  await elevatedDb.insert(schema.entries).values({
    id,
    ownerId: fx.userId,
    accountId: fx.accountId,
    entryType: "transaction",
    date: opts.date,
    descriptionCt: encText(fx.dataKey, "Purchase", id, "description_ct", 1),
    categoryId: opts.categoryId ?? null,
    merchantId: opts.merchantId ?? null,
    status: "posted",
    excluded: opts.excluded ?? false,
    enteredAmountCt: encText(fx.dataKey, opts.amount, id, "entered_amount_ct", 1),
    enteredCurrency: currency,
    accountAmountCt: encText(fx.dataKey, opts.amount, id, "account_amount_ct", 1),
    accountCurrency: currency,
    reportingCurrency: "ILS",
    fxRate: opts.fxRate === undefined ? "1" : opts.fxRate,
    fxRateDate: fxStatus === "locked" ? opts.date : null,
    fxSource: fxStatus === "locked" ? "identity" : null,
    fxStatus,
    source: "manual",
  });
}

/** Connects an in-memory MCP client to a server built for `ctx`, returns a
 * `call(name, args)` that parses the single JSON payload back. */
async function connect(ctx: AgentRequestContext) {
  const server = await buildAgentMcpServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  async function call(name: string, args: Record<string, unknown> = {}) {
    const res = await client.callTool({ name, arguments: args });
    const content = res.content as Array<{ type: string; text: string }>;
    return JSON.parse(content[0].text) as Record<string, unknown>;
  }
  async function close() {
    await client.close();
    await server.close();
  }
  return { call, close };
}

/** Seeds a full ledger for one user and returns the fixture plus its ids. */
async function seedLedger(label: string) {
  const fx = await freshFixture(label);
  const groceries = await category(fx, "Groceries", "expense");
  const salary = await category(fx, "Salary", "income");
  const internal = await category(fx, "Internal", "transfer");
  const shufersal = await merchant(fx, "Shufersal");

  await addEntry(fx, {
    date: "2026-03-05",
    amount: "-100",
    categoryId: groceries,
    merchantId: shufersal,
  });
  await addEntry(fx, { date: "2026-03-10", amount: "-50", categoryId: groceries });
  await addEntry(fx, { date: "2026-03-01", amount: "5000", categoryId: salary }); // income
  await addEntry(fx, { date: "2026-03-12", amount: "-200", categoryId: internal }); // transfer → skip
  await addEntry(fx, { date: "2026-03-15", amount: "-30", categoryId: groceries, excluded: true }); // excluded → skip
  await addEntry(fx, {
    date: "2026-03-20",
    amount: "-20",
    currency: "EUR",
    fxRate: null,
    fxStatus: "pending",
  }); // pending → skip
  // Foreign currency at a locked rate: -10 EUR × 4 = -40 ILS expense (domain does the multiply).
  await addEntry(fx, {
    date: "2026-03-22",
    amount: "-10",
    currency: "EUR",
    fxRate: "4",
    categoryId: groceries,
  });
  await addEntry(fx, { date: "2026-02-14", amount: "-70", categoryId: groceries }); // prior month

  return { fx, groceries, salary, shufersal };
}

describe("MCP tools (issue #113 Phase 3)", () => {
  it("aggregateSpending groups by category, doing FX and flow rules in the domain", async () => {
    const { fx, groceries, salary } = await seedLedger("agg-cat");
    const agg = await aggregateSpending(fx.userId, fx.dataKey, "ILS", { groupBy: "category" });

    // Groceries expenses: 100 + 50 + 40 (EUR@4) + 70 = 260. Salary income: 5000.
    const byKey = new Map(agg.groups.map((g) => [g.key, g]));
    expect(byKey.get(groceries)!.expenses).toBe("260");
    expect(byKey.get(salary)!.income).toBe("5000");
    expect(agg.totals).toEqual({ income: "5000", expenses: "260", net: "4740" });
    // Transfer + excluded excluded; pending-FX counted separately, never summed.
    expect(agg.countedEntries).toBe(5);
    expect(agg.skippedPendingFx).toBe(1);
  });

  it("aggregateSpending groups by month", async () => {
    const { fx } = await seedLedger("agg-month");
    const agg = await aggregateSpending(fx.userId, fx.dataKey, "ILS", { groupBy: "month" });
    const byKey = new Map(agg.groups.map((g) => [g.key, g]));
    expect(byKey.get("2026-03")!.expenses).toBe("190"); // 100 + 50 + 40
    expect(byKey.get("2026-03")!.income).toBe("5000");
    expect(byKey.get("2026-02")!.expenses).toBe("70");
  });

  it("the spending tool's totals match the domain layer exactly", async () => {
    const { fx } = await seedLedger("tool-spending");
    const agg = await aggregateSpending(fx.userId, fx.dataKey, "ILS", { groupBy: "category" });

    const mcp = await connect(fx.ctx);
    try {
      const out = await mcp.call("spending", { group_by: "category" });
      expect(out.totals).toEqual(agg.totals);
      expect((out.provenance as { identity: { userId: string } }).identity.userId).toBe(fx.userId);
      expect(
        (out.provenance as { completeness: { skippedPendingFx: number } }).completeness
          .skippedPendingFx,
      ).toBe(1);
    } finally {
      await mcp.close();
    }
  });

  it("the net_worth tool matches getOverview", async () => {
    const { fx } = await seedLedger("tool-networth");
    const overview = await getOverview(fx.session);

    const mcp = await connect(fx.ctx);
    try {
      const out = await mcp.call("net_worth");
      expect(out.netWorth).toEqual(overview.netWorth);
      expect(out.monthlyIncome).toEqual(overview.monthlyIncome);
      expect(out.monthlyExpenses).toEqual(overview.monthlyExpenses);
      expect((out.provenance as { identity: { userId: string } }).identity.userId).toBe(fx.userId);
    } finally {
      await mcp.close();
    }
  });

  it("the transactions tool returns the user's rows, filterable by the DK-built merchant enum", async () => {
    const { fx } = await seedLedger("tool-tx");
    const mcp = await connect(fx.ctx);
    try {
      const all = await mcp.call("transactions", {});
      expect((all.entries as unknown[]).length).toBe(8);

      // The merchant enum is built from decrypted names inside the DK window.
      const filtered = await mcp.call("transactions", { merchant: "Shufersal" });
      const rows = filtered.entries as Array<{
        merchantName: string | null;
        amount: { amount: string };
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].merchantName).toBe("Shufersal");
    } finally {
      await mcp.close();
    }
  });

  it("cross-tenant: user A's tools never see user B's ledger", async () => {
    const { fx: a } = await seedLedger("xt-a");
    const { fx: b } = await seedLedger("xt-b");

    // Domain layer, under A's scope, sums only A's entries.
    const aAgg = await aggregateSpending(a.userId, a.dataKey, "ILS", { groupBy: "category" });
    const bAgg = await aggregateSpending(b.userId, b.dataKey, "ILS", { groupBy: "category" });
    expect(aAgg.countedEntries).toBe(5);
    expect(bAgg.countedEntries).toBe(5);

    // Through the tool surface: a server built for A returns A's totals, and B
    // has an identical-shaped independent ledger — no bleed either way.
    const mcpA = await connect(a.ctx);
    try {
      const spendA = await mcpA.call("spending", { group_by: "category" });
      expect((spendA.provenance as { identity: { userId: string } }).identity.userId).toBe(
        a.userId,
      );
      // A's transactions are A's only — the 8 rows A seeded, never B's.
      const txA = await mcpA.call("transactions", {});
      expect((txA.entries as unknown[]).length).toBe(8);
    } finally {
      await mcpA.close();
    }
  });
});
