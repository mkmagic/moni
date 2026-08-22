// The MCP endpoint (issue #113 Phase 2, docs/design/mcp-and-api.md §5).
//
// One route, behind the same HTTPS terminator as everything else (src/proxy.ts
// rejects non-TLS). It speaks the MCP Streamable HTTP transport in stateless
// JSON mode: each POST is a self-contained JSON-RPC request, authorized by an
// agent token in the `Authorization: Bearer` header, answered with a single
// JSON response. No session state is kept between requests — the only state a
// request has is the DK window opened by `withAgentRequest`, which is wiped
// before the response is returned.
import { NextResponse, type NextRequest } from "next/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { AgentAuthError, withAgentRequest } from "@/lib/mcp/agent-request";
import { buildAgentMcpServer } from "@/lib/mcp/server";

function unauthorized(): NextResponse {
  // A bearer scheme challenge, and never a hint about *why* it failed —
  // unknown/expired/revoked are indistinguishable, matching the auth layer.
  return NextResponse.json(
    { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
  );
}

export async function POST(req: NextRequest): Promise<Response> {
  try {
    return await withAgentRequest(req.headers.get("authorization"), async (ctx) => {
      const server = await buildAgentMcpServer(ctx);
      // Stateless: no session id, buffered JSON response (not an SSE stream),
      // so `handleRequest` resolves only after the tool has run — i.e. while
      // the DK window is still open. The window closes (DK wiped) the moment
      // this callback returns.
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      try {
        return await transport.handleRequest(req);
      } finally {
        await server.close();
      }
    });
  } catch (err) {
    if (err instanceof AgentAuthError) return unauthorized();
    throw err;
  }
}

// Stateless mode keeps no server-initiated stream and no session to delete, so
// the GET (standalone SSE) and DELETE (session teardown) verbs have nothing to
// serve.
export function GET(): NextResponse {
  return NextResponse.json(
    { jsonrpc: "2.0", error: { code: -32000, message: "Method Not Allowed" }, id: null },
    { status: 405, headers: { Allow: "POST" } },
  );
}

export const DELETE = GET;
