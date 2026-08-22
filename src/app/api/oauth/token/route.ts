import { NextResponse } from "next/server";
import {
  OAuthErrorResponseSchema,
  OAuthTokensSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { z } from "zod";
import { exchangeAuthCode, refreshGrant, type TokenResult } from "@/domain/mcp-oauth";

const CodeGrantSchema = z.object({
  grant_type: z.literal("authorization_code"),
  code: z.string().min(1),
  code_verifier: z.string().min(1),
  client_id: z.url(),
  redirect_uri: z.url(),
  // RFC 8707 — accepted for spec conformance; the audience the grant is bound
  // to was fixed at /authorize and travels on the auth code.
  resource: z.url().optional(),
});
const RefreshGrantSchema = z.object({
  grant_type: z.literal("refresh_token"),
  refresh_token: z.string().min(1),
  client_id: z.url().optional(),
  resource: z.url().optional(),
});

const TOKEN_HEADERS = { "Cache-Control": "no-store", Pragma: "no-cache" } as const;

function oauthError(error: string, description?: string, status = 400): NextResponse {
  const body = OAuthErrorResponseSchema.parse({ error, error_description: description });
  return NextResponse.json(body, { status, headers: TOKEN_HEADERS });
}

function tokenResponse(result: TokenResult): NextResponse {
  if (!result.ok) {
    return oauthError(
      result.error,
      result.errorDescription,
      result.error === "server_error" ? 500 : 400,
    );
  }
  const body = OAuthTokensSchema.parse({
    access_token: result.accessToken,
    token_type: result.tokenType,
    expires_in: result.expiresIn,
    ...(result.refreshToken ? { refresh_token: result.refreshToken } : {}),
    scope: result.scope,
  });
  return NextResponse.json(body, { headers: TOKEN_HEADERS });
}

export async function POST(request: Request): Promise<NextResponse> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/x-www-form-urlencoded")) {
    return oauthError("invalid_request", "Expected application/x-www-form-urlencoded", 415);
  }
  const form = await request.formData().catch(() => null);
  if (!form) return oauthError("invalid_request", "Malformed form body");
  const values = Object.fromEntries(form);
  if (Object.values(values).some((value) => typeof value !== "string")) {
    return oauthError("invalid_request", "File fields are not accepted");
  }

  if (values.grant_type === "authorization_code") {
    const parsed = CodeGrantSchema.safeParse(values);
    if (!parsed.success) return oauthError("invalid_request");
    return tokenResponse(
      await exchangeAuthCode(parsed.data.code, parsed.data.code_verifier, {
        clientId: parsed.data.client_id,
        redirectUri: parsed.data.redirect_uri,
      }),
    );
  }
  if (values.grant_type === "refresh_token") {
    const parsed = RefreshGrantSchema.safeParse(values);
    if (!parsed.success) return oauthError("invalid_request");
    return tokenResponse(
      await refreshGrant(parsed.data.refresh_token, { clientId: parsed.data.client_id }),
    );
  }
  return oauthError("unsupported_grant_type");
}
