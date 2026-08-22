import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import {
  OAuthMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
  OAuthTokensSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { GET as protectedResource } from "@/app/.well-known/oauth-protected-resource/route";
import { GET as authorizationServer } from "@/app/.well-known/oauth-authorization-server/route";
import { GET as authorizeGet, POST as authorizePost } from "@/app/api/oauth/authorize/route";
import { POST as tokenPost } from "@/app/api/oauth/token/route";
import { POST as revokePost } from "@/app/api/oauth/revoke/route";
import { SESSION_COOKIE } from "@/domain/auth";
import { createUser } from "@/domain/registration";
import { updateProfile } from "@/domain/profile";
import { validateAccessToken } from "@/domain/mcp-oauth";
import { createSession, destroySession } from "@/lib/auth/session-store";
import { cleanupOwners } from "./helpers";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN;
if (!SIGNUP_TOKEN) {
  throw new Error("MONI_SIGNUP_TOKEN must be set in the test environment (see .env.example)");
}

const PASSWORD = "correct horse battery staple";
const CLIENT_ID = "https://claude.ai/oauth/claude-code-client-metadata";
const REDIRECT_URI = "http://localhost:3118/callback";
const CHATGPT_CLIENT_ID = "https://chatgpt.com/oauth/client.json";
const CHATGPT_REDIRECT_URI = "https://chatgpt.com/connector_platform_oauth_redirect";
const RESOURCE = "https://moni.example/api/mcp";
const VERIFIER = "test-verifier-that-is-long-enough-for-pkce-0123456789";
const CHALLENGE = createHash("sha256").update(VERIFIER, "ascii").digest("base64url");

function formRequest(url: string, values: Record<string, string>, cookie?: string): NextRequest {
  const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
  if (cookie) headers.set("cookie", `${SESSION_COOKIE}=${cookie}`);
  return new NextRequest(url, {
    method: "POST",
    headers,
    body: new URLSearchParams(values).toString(),
  });
}

describe("MCP OAuth routes", () => {
  const userIds: string[] = [];
  const sessionIds: string[] = [];

  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    for (const sessionId of sessionIds) destroySession(sessionId);
    await cleanupOwners(userIds);
  });

  function stubClaudeCimd(): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          client_id: CLIENT_ID,
          client_name: "Claude Code",
          redirect_uris: [REDIRECT_URI, "http://localhost/callback", "http://127.0.0.1/callback"],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        }),
      ),
    );
  }

  function stubChatGptCimd(): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          client_id: CHATGPT_CLIENT_ID,
          client_name: "ChatGPT",
          redirect_uris: [CHATGPT_REDIRECT_URI],
          token_endpoint_auth_method: "private_key_jwt",
          token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        }),
      ),
    );
  }

  async function loggedInUser(label: string): Promise<string> {
    const { userId, dataKey } = await createUser(
      `${label}-${randomUUID()}@test.moni`,
      Buffer.from(PASSWORD, "utf8"),
      SIGNUP_TOKEN!,
    );
    userIds.push(userId);
    await updateProfile(userId, { agentAccessEnabled: true });
    const sessionId = createSession(userId, dataKey, "ILS");
    sessionIds.push(sessionId);
    return sessionId;
  }

  it("advertises spec-shaped protected-resource and CIMD authorization-server metadata", () => {
    const resource = protectedResource(
      new NextRequest("https://moni.example/.well-known/oauth-protected-resource"),
    );
    const server = authorizationServer(
      new NextRequest("https://moni.example/.well-known/oauth-authorization-server"),
    );

    return Promise.all([resource.json(), server.json()]).then(([resourceBody, serverBody]) => {
      expect(OAuthProtectedResourceMetadataSchema.parse(resourceBody)).toMatchObject({
        resource: "https://moni.example/api/mcp",
        authorization_servers: ["https://moni.example"],
        scopes_supported: ["mcp:read"],
      });
      expect(OAuthMetadataSchema.parse(serverBody)).toMatchObject({
        issuer: "https://moni.example",
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        client_id_metadata_document_supported: true,
        scopes_supported: ["mcp:read", "offline_access"],
      });
    });
  });

  it("advertises the public origin when Next runs behind the TLS proxy", async () => {
    const request = (path: string) =>
      new NextRequest(`http://127.0.0.1:3000${path}`, {
        headers: { host: "moni.example", "x-forwarded-proto": "https" },
      });
    const resource = protectedResource(request("/.well-known/oauth-protected-resource"));
    const server = authorizationServer(request("/.well-known/oauth-authorization-server"));

    await expect(resource.json()).resolves.toMatchObject({
      resource: "https://moni.example/api/mcp",
      authorization_servers: ["https://moni.example"],
    });
    await expect(server.json()).resolves.toMatchObject({
      issuer: "https://moni.example",
      authorization_endpoint: "https://moni.example/api/oauth/authorize",
    });
  });

  it("rejects an unsupported client_id before making an outbound request", async () => {
    const sessionId = await loggedInUser("oauth-untrusted-client");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const query = new URLSearchParams({
      response_type: "code",
      client_id: "https://attacker.example/client.json",
      redirect_uri: "https://attacker.example/callback",
      scope: "mcp:read",
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
    });
    const response = await authorizeGet(
      new NextRequest(`https://moni.example/api/oauth/authorize?${query}`, {
        headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
      }),
    );
    expect(response.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("accepts ChatGPT's production CIMD shape and completes public-client exchange", async () => {
    stubChatGptCimd();
    const sessionId = await loggedInUser("oauth-chatgpt-route");
    const authorizeValues = {
      response_type: "code",
      client_id: CHATGPT_CLIENT_ID,
      redirect_uri: CHATGPT_REDIRECT_URI,
      resource: RESOURCE,
      scope: "mcp:read offline_access",
      state: "chatgpt-state",
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
    };

    const consent = await authorizeGet(
      new NextRequest(
        `https://moni.example/api/oauth/authorize?${new URLSearchParams(authorizeValues)}`,
        { headers: { cookie: `${SESSION_COOKIE}=${sessionId}` } },
      ),
    );
    expect(consent.status).toBe(200);
    expect(await consent.text()).toContain("chatgpt.com");

    const approved = await authorizePost(
      formRequest(
        "https://moni.example/api/oauth/authorize",
        { ...authorizeValues, decision: "approve" },
        sessionId,
      ),
    );
    expect(approved.status).toBe(302);
    const callback = new URL(approved.headers.get("location")!);
    expect(callback.origin + callback.pathname).toBe(CHATGPT_REDIRECT_URI);
    const code = callback.searchParams.get("code")!;

    const exchanged = await tokenPost(
      formRequest("https://moni.example/api/oauth/token", {
        grant_type: "authorization_code",
        code,
        code_verifier: VERIFIER,
        client_id: CHATGPT_CLIENT_ID,
        redirect_uri: CHATGPT_REDIRECT_URI,
        resource: RESOURCE,
      }),
    );
    expect(exchanged.status).toBe(200);
    expect(OAuthTokensSchema.parse(await exchanged.json()).refresh_token).toBeDefined();
  });

  it("runs consent, code exchange, refresh rotation, and revocation through form requests", async () => {
    stubClaudeCimd();
    const sessionId = await loggedInUser("oauth-route");
    const authorizeValues = {
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: "mcp:read offline_access",
      state: "opaque-state",
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
    };
    const query = new URLSearchParams(authorizeValues);
    const getResponse = await authorizeGet(
      new NextRequest(`https://moni.example/api/oauth/authorize?${query}`, {
        headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
      }),
    );
    expect(getResponse.status).toBe(200);
    expect(await getResponse.text()).toContain("claude.ai");

    const approved = await authorizePost(
      formRequest(
        "https://moni.example/api/oauth/authorize",
        { ...authorizeValues, decision: "approve" },
        sessionId,
      ),
    );
    expect(approved.status).toBe(302);
    const callback = new URL(approved.headers.get("location")!);
    expect(callback.origin + callback.pathname).toBe(REDIRECT_URI);
    expect(callback.searchParams.get("state")).toBe("opaque-state");
    const code = callback.searchParams.get("code")!;

    const exchanged = await tokenPost(
      formRequest("https://moni.example/api/oauth/token", {
        grant_type: "authorization_code",
        code,
        code_verifier: VERIFIER,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
      }),
    );
    expect(exchanged.status).toBe(200);
    const tokens = OAuthTokensSchema.parse(await exchanged.json());
    expect(tokens.refresh_token).toBeDefined();

    const refreshed = await tokenPost(
      formRequest("https://moni.example/api/oauth/token", {
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token!,
        client_id: CLIENT_ID,
      }),
    );
    expect(refreshed.status).toBe(200);
    const rotated = OAuthTokensSchema.parse(await refreshed.json());
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);

    const replay = await tokenPost(
      formRequest("https://moni.example/api/oauth/token", {
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token!,
        client_id: CLIENT_ID,
      }),
    );
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });

    expect(
      (
        await revokePost(
          formRequest("https://moni.example/api/oauth/revoke", {
            token: rotated.refresh_token!,
            token_type_hint: "refresh_token",
          }),
        )
      ).status,
    ).toBe(200);
    expect(await validateAccessToken(rotated.access_token)).toBeNull();
  });
});
