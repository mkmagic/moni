// The MCP server surface for the agent endpoint (issue #113 Phase 2).
//
// One server is built per request, closed over that request's authenticated
// context (src/lib/mcp/agent-request.ts) — so every tool it exposes is already
// scoped to one user and one DK window; a tool never has to remember to filter
// by user, and never sees another user's data.
//
// Phase 2 ships exactly ONE trivial, read-only tool (`whoami`) to prove the
// pipe end to end: bearer token → DK window → RLS-scoped domain read → JSON
// back to the client. The real computed / aggregation / raw-row tools are
// Phase 3 (docs/design/mcp-and-api.md §6); this module is where they will be
// registered, all sharing this same per-request confinement.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { eq } from "drizzle-orm";
import { withUser } from "@/db/client";
import { users } from "@/db/schema";
import type { AgentRequestContext } from "@/lib/mcp/agent-request";

/** Server identity advertised to MCP clients during the initialize handshake. */
const SERVER_INFO = { name: "moni", version: "1.3.0" } as const;

/**
 * Builds a fresh {@link McpServer} whose tools all run as `ctx.userId` under
 * RLS. The returned server is single-use: connect it to a per-request
 * transport, handle the request, discard it.
 */
export function buildAgentMcpServer(ctx: AgentRequestContext): McpServer {
  const server = new McpServer(SERVER_INFO);

  // Trivial read-only tool (Phase 2 verify): reaches the DB as exactly this
  // user through `withUser`, returning only their own non-sensitive identity.
  // It touches no ciphertext, so it does not need `ctx.dataKey` — but it runs
  // inside the same DK window, and Phase 3's decrypting tools will use it.
  server.registerTool(
    "whoami",
    {
      description:
        "Returns the identity of the account this agent token belongs to " +
        "(user id and base currency). Read-only.",
      inputSchema: {},
    },
    async () => {
      const identity = await withUser(ctx.userId, async (tx) => {
        const rows = await tx
          .select({ id: users.id, baseCurrency: users.baseCurrency })
          .from(users)
          .where(eq(users.id, ctx.userId))
          .limit(1);
        return rows[0] ?? null;
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              userId: identity?.id ?? ctx.userId,
              baseCurrency: identity?.baseCurrency ?? null,
            }),
          },
        ],
      };
    },
  );

  return server;
}
