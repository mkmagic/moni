import { NextResponse, type NextRequest } from "next/server";
import { getSessionFromRequest } from "@/domain/auth";
import { AgentAccessDisabledError } from "@/domain/agent-token";
import { createAuthCode } from "@/domain/mcp-oauth";
import {
  escapeHtml,
  validateAuthorizationRequest,
  type ValidAuthorizationRequest,
} from "@/lib/mcp/oauth-http";

function error(status: number, description: string): NextResponse {
  return NextResponse.json(
    { error: "invalid_request", error_description: description },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function redirectToClient(
  request: ValidAuthorizationRequest,
  values: { code?: string; error?: string },
): NextResponse {
  const location = new URL(request.redirectUri);
  if (values.code) location.searchParams.set("code", values.code);
  if (values.error) location.searchParams.set("error", values.error);
  if (request.state !== undefined) location.searchParams.set("state", request.state);
  return new NextResponse(null, {
    status: 302,
    headers: { Location: location.href, "Cache-Control": "no-store" },
  });
}

function hidden(name: string, value: string | undefined): string {
  if (value === undefined) return "";
  return `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
}

function consentPage(request: ValidAuthorizationRequest): NextResponse {
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Authorize AI client · Moni</title></head><body><main>
<h1>Allow this AI client read-only access?</h1>
<p><strong>${escapeHtml(request.clientHost)}</strong> is asking to read your Moni financial data through MCP.</p>
<p>This cannot change Moni data or access saved bank credentials. You can revoke it from AI settings.</p>
<form method="post" action="/api/oauth/authorize">
${hidden("response_type", request.responseType)}${hidden("client_id", request.clientId)}
${hidden("redirect_uri", request.redirectUri)}${hidden("scope", request.scope)}
${hidden("state", request.state)}${hidden("code_challenge", request.codeChallenge)}
${hidden("code_challenge_method", request.codeChallengeMethod)}
<button type="submit" name="decision" value="approve">Allow read-only access</button>
<button type="submit" name="decision" value="deny">Cancel</button>
</form></main></body></html>`;
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    },
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!getSessionFromRequest(request)) return error(401, "A live Moni session is required");
  const oauthRequest = await validateAuthorizationRequest(request.nextUrl.searchParams);
  if (!oauthRequest) return error(400, "Invalid OAuth client or authorization request");
  return consentPage(oauthRequest);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = getSessionFromRequest(request);
  if (!session) return error(401, "A live Moni session is required");
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/x-www-form-urlencoded")) {
    return error(415, "Expected application/x-www-form-urlencoded");
  }
  const form = await request.formData().catch(() => null);
  if (!form) return error(400, "Malformed form body");
  const params = new URLSearchParams();
  for (const [key, value] of form) {
    if (typeof value !== "string") return error(400, "File fields are not accepted");
    if (key !== "decision") params.append(key, value);
  }
  const oauthRequest = await validateAuthorizationRequest(params);
  if (!oauthRequest) return error(400, "Invalid OAuth client or authorization request");
  const decision = form.get("decision");
  if (decision === "deny") return redirectToClient(oauthRequest, { error: "access_denied" });
  if (decision !== "approve") return error(400, "A consent decision is required");

  try {
    const { code } = await createAuthCode(session.userId, session.dataKey, {
      clientId: oauthRequest.clientId,
      redirectUri: oauthRequest.redirectUri,
      scope: oauthRequest.scope,
      codeChallenge: oauthRequest.codeChallenge,
    });
    return redirectToClient(oauthRequest, { code });
  } catch (cause) {
    if (cause instanceof AgentAccessDisabledError) {
      return error(403, "Agent access is not enabled for this user");
    }
    throw cause;
  }
}
