// The MCP server surface for the agent endpoint (issue #113 Phase 3).
//
// One server is built per request, closed over that request's authenticated
// context (src/lib/mcp/agent-request.ts) — so every tool is already scoped to
// one user and one DK window; a tool never has to remember to filter by user,
// and never sees another user's data (docs/design/mcp-and-api.md §7).
//
// Three read-only tools, the shape #19 fixed:
//   * `net_worth`      — an authoritative computed figure, reusing the EXACT
//                        domain computation the dashboard uses (getOverview),
//                        so the model never reimplements Moni's money math.
//   * `spending`       — the aggregation workhorse: server-side group/sum over
//                        the whole ledger (aggregateSpending).
//   * `transactions`   — the raw-row escape hatch for genuine drill-downs,
//                        high-capped (physics, not a security control).
// (`whoami` stays as the trivial identity probe.)
//
// Every tool result carries a provenance block — identity (the user it ran
// as), freshness, and completeness/sampling — so the model can tell the user
// how current and how complete a figure is, and never presents a stale or
// partial number as authoritative.
//
// Tool input schemas are built PER REQUEST from the user's own data: the
// category and merchant filters are enums of that user's actual categories and
// merchants. The merchant names are Tier-1 (encrypted), so that enum is built
// inside the request's DK window (the #19 finding), never cached in plaintext.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { withUser } from "@/db/client";
import { categories, merchants, users } from "@/db/schema";
import type { Session } from "@/lib/auth/session-store";
import { decText } from "@/domain/fields";
import { getOverview } from "@/domain/dashboard";
import { aggregateSpending } from "@/domain/aggregates";
import { listEntries } from "@/domain/transactions";
import type { AgentRequestContext } from "@/lib/mcp/agent-request";

const SERVER_INFO = { name: "moni", version: "1.3.0" } as const;

/** Raw-row ceiling. A context/physics limit (a year of rows can't fit a model
 * prompt), NOT a security control — there is no artificial security row cap
 * (docs/design/mcp-and-api.md §6, threat-model §5.6). */
const RAW_ROW_CAP = 5000;

/** The identity every tool result is stamped with — the user it ran as. */
type Provenance = {
  identity: { userId: string };
  freshness: unknown;
  completeness: unknown;
};

/** Per-request lookups baked into the tool schemas, read once up front. */
interface RequestData {
  baseCurrency: string;
  /** Category name → id (first wins on a duplicate name). */
  categoryByName: Map<string, string>;
  /** Merchant name → id, decrypted inside the DK window. */
  merchantByName: Map<string, string>;
}

async function loadRequestData(ctx: AgentRequestContext): Promise<RequestData> {
  return withUser(ctx.userId, async (tx) => {
    const [userRow] = await tx
      .select({ baseCurrency: users.baseCurrency })
      .from(users)
      .where(eq(users.id, ctx.userId))
      .limit(1);

    const catRows = await tx.select({ id: categories.id, name: categories.name }).from(categories);
    const categoryByName = new Map<string, string>();
    for (const c of catRows) if (!categoryByName.has(c.name)) categoryByName.set(c.name, c.id);

    const merRows = await tx
      .select({ id: merchants.id, nameCt: merchants.nameCt, version: merchants.version })
      .from(merchants);
    const merchantByName = new Map<string, string>();
    for (const m of merRows) {
      const name = decText(ctx.dataKey, m.nameCt, m.id, "name_ct", m.version);
      if (name && !merchantByName.has(name)) merchantByName.set(name, m.id);
    }

    return { baseCurrency: userRow?.baseCurrency ?? "ILS", categoryByName, merchantByName };
  });
}

/** A Session shape for the domain reads that expect one. The agent request is
 * NOT a browser session — it has no cookie/TTL — but getOverview/listEntries
 * only read `userId`, `dataKey`, and `baseCurrency`, so this is exactly the
 * context they need and nothing more is invented. */
function sessionFor(ctx: AgentRequestContext, baseCurrency: string): Session {
  return {
    id: "agent",
    userId: ctx.userId,
    dataKey: ctx.dataKey,
    baseCurrency,
    syncPromptDismissed: true,
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
}

/** Wraps a payload + provenance as the single JSON text block MCP returns. */
function jsonResult(payload: unknown, provenance: Provenance) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify({ ...(payload as object), provenance }) },
    ],
  };
}

/** An optional enum of the given names, or an optional free string when the
 * user has none yet (z.enum rejects an empty tuple). */
function optionalNameEnum(names: string[]) {
  return names.length ? z.enum(names as [string, ...string[]]).optional() : z.string().optional();
}

const ISO_DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected an ISO date (YYYY-MM-DD)")
  .optional();

/**
 * Builds a fresh {@link McpServer} whose tools all run as `ctx.userId` under
 * RLS. Async because the per-request tool schemas (category/merchant enums)
 * are read from the user's own data inside the DK window. Single-use: connect
 * it to a per-request transport, handle the request, discard it.
 */
export async function buildAgentMcpServer(ctx: AgentRequestContext): Promise<McpServer> {
  const data = await loadRequestData(ctx);
  const identity = { userId: ctx.userId };
  const server = new McpServer(SERVER_INFO);

  server.registerTool(
    "whoami",
    {
      description:
        "Returns the identity of the account this agent token belongs to " +
        "(user id and base currency). Read-only.",
      inputSchema: {},
    },
    () =>
      jsonResult(
        { userId: ctx.userId, baseCurrency: data.baseCurrency },
        { identity, freshness: { asOf: "now" }, completeness: { full: true } },
      ),
  );

  server.registerTool(
    "net_worth",
    {
      description:
        "The account's current net worth and this month's income/expenses, " +
        "computed by Moni's own money engine (exact-decimal, in base currency). " +
        "Use this figure directly — do not recompute it. Read-only.",
      inputSchema: {},
    },
    async () => {
      const overview = await getOverview(sessionFor(ctx, data.baseCurrency));
      return jsonResult(
        {
          baseCurrency: overview.baseCurrency,
          currentMonth: overview.currentMonth,
          netWorth: overview.netWorth,
          assetsTotal: overview.assetsTotal,
          monthlyIncome: overview.monthlyIncome,
          monthlyExpenses: overview.monthlyExpenses,
          months: overview.months,
        },
        {
          identity,
          // The valuation's own freshness: source/quote/fx as-of dates and how
          // current it is (Moni computes this; the model must not restate it).
          freshness: overview.netWorthMetadata,
          completeness: {
            affectedComponentCount: overview.netWorthMetadata.affectedComponentCount,
            qualityFlags: overview.netWorthMetadata.qualityFlags,
          },
        },
      );
    },
  );

  server.registerTool(
    "spending",
    {
      description:
        "Server-side aggregation over the whole ledger: income/expenses/net " +
        "grouped by category or by month, summed in base currency by Moni's " +
        "money engine. Prefer this over pulling raw rows for any 'how much' " +
        "question. Read-only.",
      inputSchema: {
        group_by: z.enum(["category", "month"]).default("category"),
        from: ISO_DATE,
        to: ISO_DATE,
      },
    },
    async ({ group_by, from, to }) => {
      const aggregate = await aggregateSpending(ctx.userId, ctx.dataKey, data.baseCurrency, {
        groupBy: group_by,
        from,
        to,
      });
      return jsonResult(aggregate, {
        identity,
        freshness: { asOf: to ?? "now" },
        completeness: {
          countedEntries: aggregate.countedEntries,
          // Entries whose base-currency amount isn't knowable yet (pending FX)
          // are excluded from the sums, not guessed — so the model can caveat.
          skippedPendingFx: aggregate.skippedPendingFx,
        },
      });
    },
  );

  const categoryNames = [...data.categoryByName.keys()];
  const merchantNames = [...data.merchantByName.keys()];
  server.registerTool(
    "transactions",
    {
      description:
        "Individual ledger entries for a genuine drill-down (one merchant, one " +
        "month). For aggregate 'how much' questions use `spending` instead — a " +
        "wide range is capped and returns the most recent entries. Read-only.",
      inputSchema: {
        from: ISO_DATE,
        to: ISO_DATE,
        limit: z.number().int().positive().max(RAW_ROW_CAP).optional(),
        category: optionalNameEnum(categoryNames),
        merchant: optionalNameEnum(merchantNames),
      },
    },
    async ({ from, to, limit, category, merchant }) => {
      const rows = await listEntries(sessionFor(ctx, data.baseCurrency), {
        from,
        to,
        limit: limit ?? RAW_ROW_CAP,
        categoryId: category ? data.categoryByName.get(category) : undefined,
        merchantId: merchant ? data.merchantByName.get(merchant) : undefined,
      });
      const fxPendingRows = rows.filter((r) => r.fxPending).length;
      return jsonResult(
        { entries: rows },
        {
          identity,
          freshness: { asOf: to ?? "now" },
          completeness: {
            returned: rows.length,
            cap: limit ?? RAW_ROW_CAP,
            // At the cap the newest rows are complete but older ones are cut —
            // the model should aggregate via `spending`, not sum these.
            truncated: rows.length >= (limit ?? RAW_ROW_CAP),
            fxPendingRows,
          },
        },
      );
    },
  );

  return server;
}
