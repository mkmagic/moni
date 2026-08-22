import { NextResponse, type NextRequest } from "next/server";
import { getSessionFromRequest } from "@/domain/auth";
import { AgentAccessDisabledError } from "@/domain/agent-token";
import { createAuthCode } from "@/domain/mcp-oauth";
import {
  escapeHtml,
  issuerFromRequest,
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

function consentPage(request: ValidAuthorizationRequest, issuer: string): NextResponse {
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Authorize AI client · Moni</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: radial-gradient(circle at 50% 0%, rgba(245, 166, 35, .16), transparent 38%), #0c0e14; color: #e8eaef; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.shell { width: min(100% - 2rem, 30rem); margin: 0 auto; min-height: 100vh; display: flex; flex-direction: column; justify-content: center; padding: 3rem 0; }
.brand { display: flex; flex-direction: column; align-items: center; gap: .75rem; margin-bottom: 2rem; }
.brand-logo { width: 5.75rem; height: auto; filter: drop-shadow(0 12px 24px rgba(245, 166, 35, .18)); }
.wordmark { font-size: 2rem; font-weight: 700; letter-spacing: -.04em; }
.tagline { margin: -.35rem 0 0; color: #98a0b0; font-size: .875rem; }
.card { border: 1px solid #252a36; border-radius: .875rem; background: #14171f; padding: 2rem; }
.eyebrow { margin-bottom: .75rem; color: #f5a623; font-size: .75rem; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
h1 { margin: 0; font-size: 1.5rem; line-height: 1.25; letter-spacing: -.025em; }
.intro { margin: .75rem 0 1.5rem; color: #98a0b0; font-size: .925rem; line-height: 1.6; }
.client { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 1.25rem; border: 1px solid #252a36; border-radius: .625rem; background: #0c0e14; padding: .875rem 1rem; }
.client span { color: #98a0b0; font-size: .75rem; }
.client strong { overflow: hidden; color: #e8eaef; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8rem; text-overflow: ellipsis; white-space: nowrap; }
.privacy { margin: 0 0 1.5rem; color: #98a0b0; font-size: .8rem; line-height: 1.55; }
.actions { display: grid; grid-template-columns: 1fr auto; gap: .75rem; }
button { min-height: 2.75rem; border-radius: .625rem; padding: .65rem 1rem; font: inherit; font-size: .875rem; font-weight: 650; cursor: pointer; }
button:focus-visible { outline: 2px solid #f5a623; outline-offset: 2px; }
button[value="approve"] { border: 1px solid #f5a623; background: #f5a623; color: #2d210c; }
button[value="approve"]:hover { background: #ffb43d; }
button[value="deny"] { border: 1px solid #252a36; background: transparent; color: #e8eaef; }
button[value="deny"]:hover { background: #252a36; }
.footer { margin: 1rem 0 0; color: #6f7788; font-size: .75rem; line-height: 1.5; text-align: center; }
@media (max-width: 30rem) { .card { padding: 1.5rem; } .actions { grid-template-columns: 1fr; } button[value="deny"] { order: 2; } }
</style></head><body><main class="shell">
<header class="brand"><img class="brand-logo" src="/moni-icon.png" alt=""><span class="wordmark">Moni</span><p class="tagline">Your money, in focus.</p></header>
<section class="card"><div class="eyebrow">Secure AI connection</div>
<h1>Allow read-only access?</h1>
<p class="intro">Connect this AI client to your Moni account.</p>
<div class="client"><span>Requesting client</span><strong>${escapeHtml(request.clientHost)}</strong></div>
<p class="privacy">It can read your financial data through MCP. It cannot change Moni data or access saved bank credentials, and you can revoke it at any time.</p>
<form class="actions" method="post" action="${escapeHtml(issuer)}/api/oauth/authorize">
${hidden("response_type", request.responseType)}${hidden("client_id", request.clientId)}
${hidden("redirect_uri", request.redirectUri)}${hidden("scope", request.scope)}
${hidden("state", request.state)}${hidden("code_challenge", request.codeChallenge)}
${hidden("code_challenge_method", request.codeChallengeMethod)}${hidden("resource", request.resource)}
<button type="submit" name="decision" value="approve">Allow read-only access</button>
<button type="submit" name="decision" value="deny">Cancel</button>
</form></section><p class="footer">Protected by Moni&apos;s read-only agent access controls.</p></main></body></html>`;
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      // Chrome suppresses this native consent POST when CSP includes form-action,
      // even for the matching explicit origin. The absolute action remains same-origin.
      "Content-Security-Policy":
        "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    },
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!getSessionFromRequest(request)) return error(401, "A live Moni session is required");
  const oauthRequest = await validateAuthorizationRequest(request.nextUrl.searchParams);
  if (!oauthRequest) return error(400, "Invalid OAuth client or authorization request");
  return consentPage(oauthRequest, issuerFromRequest(request));
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
      resource: oauthRequest.resource,
    });
    return redirectToClient(oauthRequest, { code });
  } catch (cause) {
    if (cause instanceof AgentAccessDisabledError) {
      return error(403, "Agent access is not enabled for this user");
    }
    throw cause;
  }
}
