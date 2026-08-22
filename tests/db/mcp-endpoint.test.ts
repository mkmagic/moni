// MCP endpoint auth + DK window (issue #113 Phase 2). Two layers are covered:
//   1. `withAgentRequest` — the security-critical part: token → one user + a
//      usable DK, wiped the instant the request settles. Asserted directly, no
//      HTTP round-trip.
//   2. The `/api/mcp` route and the `whoami` tool — the pipe end to end: a
//      bearer token reaches an RLS-scoped read and comes back as JSON, and a
//      missing/bad token is 401.
import { afterAll, describe, expect, it } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createUser } from "@/domain/registration";
import { updateProfile } from "@/domain/profile";
import { mintToken, revokeToken } from "@/domain/agent-token";
import { createAuthCode, exchangeAuthCode, listGrants } from "@/domain/mcp-oauth";
import { withUser } from "@/db/client";
import * as schema from "@/db/schema";
import { AgentAuthError, withAgentRequest } from "@/lib/mcp/agent-request";
import { buildAgentMcpServer } from "@/lib/mcp/server";
import { POST as mcpPost, GET as mcpGet } from "@/app/api/mcp/route";
import { cleanupOwners } from "./helpers";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN;
if (!SIGNUP_TOKEN) {
  throw new Error("MONI_SIGNUP_TOKEN must be set in the test environment (see .env.example)");
}

const PASSWORD = "correct horse battery staple";

function jsonRpcRequest(body: unknown, bearer?: string): NextRequest {
  const headers = new Headers({
    "content-type": "application/json",
    // Streamable HTTP requires the client to accept both.
    accept: "application/json, text/event-stream",
  });
  if (bearer) headers.set("authorization", `Bearer ${bearer}`);
  return new NextRequest("http://localhost:3000/api/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const INITIALIZE = {
  jsonrpc: "2.0" as const,
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0.0.0" },
  },
};

describe("MCP endpoint (issue #113 Phase 2)", () => {
  const createdUserIds: string[] = [];
  afterAll(async () => cleanupOwners(createdUserIds));

  async function user(label: string): Promise<{ userId: string; dataKey: Buffer }> {
    const email = `${label}-${randomUUID()}@test.moni`;
    const { userId, dataKey } = await createUser(
      email,
      Buffer.from(PASSWORD, "utf8"),
      SIGNUP_TOKEN!,
    );
    createdUserIds.push(userId);
    // Agent access is opt-in (Phase 5): minting and verify both require it on.
    await updateProfile(userId, { agentAccessEnabled: true });
    return { userId, dataKey };
  }

  async function oauthAccessToken(userId: string, dataKey: Buffer): Promise<string> {
    const verifier = randomBytes(32).toString("base64url");
    const { code } = await createAuthCode(userId, dataKey, {
      clientId: "https://claude.ai/oauth/claude-code-client-metadata",
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
      scope: "mcp:read offline_access",
      codeChallenge: createHash("sha256").update(verifier, "ascii").digest("base64url"),
    });
    const result = await exchangeAuthCode(code, verifier, {
      clientId: "https://claude.ai/oauth/claude-code-client-metadata",
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
    });
    if (!result.ok) throw new Error(`test setup: OAuth exchange failed (${result.error})`);
    return result.accessToken;
  }

  describe("withAgentRequest", () => {
    it("resolves a valid token to its user, hands over a usable DK, and wipes it after", async () => {
      const { userId, dataKey } = await user("mcp-window");
      const { secret } = await mintToken(userId, dataKey);

      let captured: Buffer | null = null;
      const result = await withAgentRequest(`Bearer ${secret}`, async (ctx) => {
        expect(ctx.userId).toBe(userId);
        expect(ctx.dataKey.equals(dataKey)).toBe(true);
        captured = ctx.dataKey;
        return "ok";
      });

      expect(result).toBe("ok");
      // The DK the callback held is zeroed the moment the window closed.
      expect(captured).not.toBeNull();
      expect(Buffer.alloc(captured!.length).equals(captured!)).toBe(true);
    });

    it("wipes the DK even when the callback throws", async () => {
      const { userId, dataKey } = await user("mcp-window-throw");
      const { secret } = await mintToken(userId, dataKey);

      let captured: Buffer | null = null;
      await expect(
        withAgentRequest(`Bearer ${secret}`, async (ctx) => {
          captured = ctx.dataKey;
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(Buffer.alloc(captured!.length).equals(captured!)).toBe(true);
    });

    it("accepts an OAuth access token and wipes its DK when the window closes", async () => {
      const { userId, dataKey } = await user("mcp-oauth-window");
      const accessToken = await oauthAccessToken(userId, dataKey);
      let captured: Buffer | null = null;

      const result = await withAgentRequest(`Bearer ${accessToken}`, async (ctx) => {
        expect(ctx.userId).toBe(userId);
        expect(ctx.dataKey.equals(dataKey)).toBe(true);
        expect(ctx.credentialKind).toBe("oauth-grant");
        captured = ctx.dataKey;
        return "ok";
      });

      expect(result).toBe("ok");
      expect(Buffer.alloc(captured!.length).equals(captured!)).toBe(true);
    });

    it("rejects a missing, malformed, revoked, or expired token before running fn", async () => {
      const { userId, dataKey } = await user("mcp-window-bad");
      const { tokenId, secret } = await mintToken(userId, dataKey);
      const expired = await mintToken(userId, dataKey, { ttlMs: -1000 });

      const fn = async () => "ran";
      await expect(withAgentRequest(null, fn)).rejects.toBeInstanceOf(AgentAuthError);
      await expect(withAgentRequest("Basic abc", fn)).rejects.toBeInstanceOf(AgentAuthError);
      await expect(
        withAgentRequest(`Bearer moni_agent_${randomBytes(32).toString("base64url")}`, fn),
      ).rejects.toBeInstanceOf(AgentAuthError);
      await expect(withAgentRequest(`Bearer ${expired.secret}`, fn)).rejects.toBeInstanceOf(
        AgentAuthError,
      );

      await revokeToken(userId, tokenId);
      await expect(withAgentRequest(`Bearer ${secret}`, fn)).rejects.toBeInstanceOf(AgentAuthError);
    });
  });

  describe("the whoami tool, over an in-memory MCP session", () => {
    it("advertises every tool as read-only", async () => {
      const { userId, dataKey } = await user("mcp-tool-annotations");
      const server = await buildAgentMcpServer({ userId, tokenId: randomUUID(), dataKey });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test", version: "0.0.0" });

      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        const { tools } = await client.listTools();
        expect(tools.length).toBeGreaterThan(0);
        expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
      } finally {
        await client.close();
        await server.close();
      }
    });

    it("returns the authenticated user's own identity, RLS-scoped", async () => {
      const { userId, dataKey } = await user("mcp-whoami");
      // A real token id is needed: every tool call now writes an audit row
      // whose token_id FKs agent_tokens (Phase 4).
      const { tokenId } = await mintToken(userId, dataKey);
      const server = await buildAgentMcpServer({ userId, tokenId, dataKey });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test", version: "0.0.0" });

      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        const res = await client.callTool({ name: "whoami", arguments: {} });
        const content = res.content as Array<{ type: string; text: string }>;
        // Result is tagged (Phase 4): an untrusted-data notice, then the JSON.
        expect(content[0].text).toContain("untrusted");
        const payload = JSON.parse(content[1].text) as { userId: string; baseCurrency: string };
        expect(payload.userId).toBe(userId);
        expect(payload.baseCurrency).toBe("ILS");
      } finally {
        await client.close();
        await server.close();
      }
    });
  });

  describe("the /api/mcp route", () => {
    it("401s with no bearer token", async () => {
      const res = await mcpPost(jsonRpcRequest(INITIALIZE));
      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toBe(
        'Bearer error="invalid_token", resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/mcp", scope="mcp:read"',
      );
    });

    it("401s with a bad bearer token", async () => {
      const res = await mcpPost(
        jsonRpcRequest(INITIALIZE, `moni_agent_${randomBytes(32).toString("base64url")}`),
      );
      expect(res.status).toBe(401);
    });

    it("completes the initialize handshake for a valid token", async () => {
      const { userId, dataKey } = await user("mcp-route-init");
      const { secret } = await mintToken(userId, dataKey);

      const res = await mcpPost(jsonRpcRequest(INITIALIZE, secret));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { result?: { serverInfo?: { name?: string } } };
      expect(body.result?.serverInfo?.name).toBe("moni");
    });

    it("completes the initialize handshake for a valid OAuth access token", async () => {
      const { userId, dataKey } = await user("mcp-route-oauth-init");
      const accessToken = await oauthAccessToken(userId, dataKey);

      const res = await mcpPost(jsonRpcRequest(INITIALIZE, accessToken));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { result?: { serverInfo?: { name?: string } } };
      expect(body.result?.serverInfo?.name).toBe("moni");
    });

    it("attributes an OAuth tool call to its grant in the audit log", async () => {
      const { userId, dataKey } = await user("mcp-route-oauth-audit");
      const accessToken = await oauthAccessToken(userId, dataKey);
      const [grant] = await listGrants(userId);

      const res = await mcpPost(
        jsonRpcRequest(
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "whoami", arguments: {} },
          },
          accessToken,
        ),
      );
      expect(res.status).toBe(200);

      const rows = await withUser(userId, (tx) =>
        tx
          .select({
            tokenId: schema.agentAccessLog.tokenId,
            oauthGrantId: schema.agentAccessLog.oauthGrantId,
          })
          .from(schema.agentAccessLog)
          .where(eq(schema.agentAccessLog.oauthGrantId, grant.id)),
      );
      expect(rows).toEqual([{ tokenId: null, oauthGrantId: grant.id }]);
    });

    it("405s a GET (no server-initiated stream in stateless mode)", () => {
      const res = mcpGet();
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("POST");
    });
  });
});
