import { OAuthClientMetadataSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import { z } from "zod";

const SUPPORTED_CLIENT_HOSTS = new Set(["claude.ai", "chatgpt.com"]);
const MAX_CLIENT_DOCUMENT_BYTES = 64 * 1024;
const CLIENT_DOCUMENT_TIMEOUT_MS = 5_000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);
const PKCE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const SUPPORTED_SCOPES = new Set(["mcp:read", "offline_access"]);

const AuthorizationRequestSchema = z.object({
  response_type: z.literal("code"),
  client_id: z.url(),
  redirect_uri: z.url(),
  scope: z.string().trim().min(1).max(200),
  state: z.string().max(1_024).optional(),
  code_challenge: z.string().regex(PKCE_CHALLENGE_RE),
  code_challenge_method: z.literal("S256"),
  // RFC 8707 / MCP 2025-11-25 — the resource (audience) the token is for.
  resource: z.url().max(500).optional(),
});

export interface ValidAuthorizationRequest {
  responseType: "code";
  clientId: string;
  clientHost: string;
  redirectUri: string;
  scope: string;
  state?: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  resource?: string;
}

function uniqueParams(params: URLSearchParams): Record<string, string> | null {
  const values: Record<string, string> = {};
  for (const key of params.keys()) {
    const all = params.getAll(key);
    if (all.length !== 1) return null;
    values[key] = all[0];
  }
  return values;
}

function safeSupportedClientUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (!SUPPORTED_CLIENT_HOSTS.has(url.hostname)) return null;
  if (url.port !== "" && url.port !== "443") return null;
  if (url.username || url.password || url.hash) return null;
  return url;
}

function loopbackRedirectMatches(requested: URL, registered: URL): boolean {
  if (requested.protocol !== "http:" || registered.protocol !== "http:") return false;
  if (!LOOPBACK_HOSTS.has(requested.hostname) || requested.hostname !== registered.hostname) {
    return false;
  }
  return (
    requested.username === "" &&
    requested.password === "" &&
    requested.pathname === registered.pathname &&
    requested.search === registered.search &&
    requested.hash === registered.hash
  );
}

function redirectUriAllowed(clientId: URL, requestedValue: string, registeredValues: string[]) {
  let requested: URL;
  try {
    requested = new URL(requestedValue);
  } catch {
    return false;
  }
  if (requested.username || requested.password || requested.hash) return false;

  for (const registeredValue of registeredValues) {
    const registered = new URL(registeredValue);
    if (requested.href === registered.href && requested.origin === clientId.origin) return true;
    if (loopbackRedirectMatches(requested, registered)) return true;
  }
  return false;
}

async function loadClientMetadata(clientId: URL): Promise<unknown | null> {
  try {
    const response = await fetch(clientId.href, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(CLIENT_DOCUMENT_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) return null;
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_CLIENT_DOCUMENT_BYTES) return null;
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_CLIENT_DOCUMENT_BYTES) return null;
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Validates the OAuth request and its allowlisted, self-referential CIMD. */
export async function validateAuthorizationRequest(
  params: URLSearchParams,
): Promise<ValidAuthorizationRequest | null> {
  const values = uniqueParams(params);
  if (!values) return null;
  const parsed = AuthorizationRequestSchema.safeParse(values);
  if (!parsed.success) return null;

  const clientId = safeSupportedClientUrl(parsed.data.client_id);
  if (!clientId) return null;
  const requestedScopes = parsed.data.scope.split(/\s+/);
  if (
    !requestedScopes.includes("mcp:read") ||
    requestedScopes.some((scope) => !SUPPORTED_SCOPES.has(scope))
  ) {
    return null;
  }
  const scope = [
    "mcp:read",
    ...(requestedScopes.includes("offline_access") ? ["offline_access"] : []),
  ].join(" ");

  const rawMetadata = await loadClientMetadata(clientId);
  if (!rawMetadata || typeof rawMetadata !== "object") return null;
  const rawClientId = (rawMetadata as { client_id?: unknown }).client_id;
  if (rawClientId !== clientId.href) return null;
  const metadata = OAuthClientMetadataSchema.safeParse(rawMetadata);
  if (!metadata.success) return null;
  const rawAuthMethods = (rawMetadata as { token_endpoint_auth_methods_supported?: unknown })
    .token_endpoint_auth_methods_supported;
  const authMethods = z.array(z.string().max(64)).min(1).max(8).safeParse(rawAuthMethods);
  if (rawAuthMethods !== undefined) {
    if (!authMethods.success || !authMethods.data.includes("none")) return null;
  } else if (
    metadata.data.token_endpoint_auth_method !== undefined &&
    metadata.data.token_endpoint_auth_method !== "none"
  ) {
    return null;
  }
  if (metadata.data.response_types && !metadata.data.response_types.includes("code")) return null;
  if (metadata.data.grant_types && !metadata.data.grant_types.includes("authorization_code")) {
    return null;
  }
  if (!redirectUriAllowed(clientId, parsed.data.redirect_uri, metadata.data.redirect_uris)) {
    return null;
  }

  return {
    responseType: "code",
    clientId: clientId.href,
    clientHost: clientId.hostname,
    redirectUri: parsed.data.redirect_uri,
    scope,
    state: parsed.data.state,
    codeChallenge: parsed.data.code_challenge,
    codeChallengeMethod: "S256",
    resource: parsed.data.resource,
  };
}

export function issuerFromRequest(request: Request): string {
  const requestOrigin = new URL(request.url).origin;
  const host = request.headers.get("host");
  const forwardedProto = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    .trim()
    .toLowerCase();
  if (!host || (forwardedProto !== "http" && forwardedProto !== "https")) return requestOrigin;

  try {
    return new URL(`${forwardedProto}://${host}`).origin;
  } catch {
    return requestOrigin;
  }
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
