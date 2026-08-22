// The per-request authorization + DK window for the MCP endpoint (issue #113
// Phase 2, docs/design/mcp-and-api.md §1/§7).
//
// This is the one place an agent token is turned into a live read context.
// The flow, per request, is exactly: extract the bearer token → resolve it to
// one user and unwrap that user's DK (src/domain/agent-token.ts) → hand a
// callback a `{ userId, dataKey }` context → `fill(0)` the DK the instant the
// callback returns, win or lose. No standing DK survives a request.
//
// Kept deliberately transport-agnostic so it is unit-testable without an HTTP
// round-trip: the security-critical properties (right user, DK usable during
// the window, DK wiped after) are asserted directly against this function.
import { verifyAndUnwrapDk } from "@/domain/agent-token";
import { OAUTH_ACCESS_TOKEN_PREFIX, validateAccessToken } from "@/domain/mcp-oauth";
import { wipe } from "@/lib/crypto";

/** The live read context a token grants for the span of one request. */
export interface AgentRequestContext {
  userId: string;
  /** Static token id or OAuth grant id. `credentialKind` selects the audit FK. */
  tokenId: string;
  /** Omitted by legacy/internal callers means the existing static-token path. */
  credentialKind?: "agent-token" | "oauth-grant";
  /**
   * The user's data key, valid ONLY for the duration of the callback. It is
   * `fill(0)`-wiped when the callback settles — do not retain a reference past
   * the callback body.
   */
  dataKey: Buffer;
}

/** Raised when a request carries no usable token. The route maps it to 401. */
export class AgentAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentAuthError";
  }
}

/**
 * Parses a bearer token out of an `Authorization` header value. Returns null
 * for a missing header or any scheme other than `Bearer` (case-insensitive).
 */
export function parseBearer(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/**
 * Verifies `authorizationHeader`'s bearer token and runs `fn` inside the
 * resulting DK window. Throws {@link AgentAuthError} (before `fn` runs) if the
 * token is missing, malformed, unknown, expired, or revoked. The DK is wiped
 * in a `finally`, so it is gone whether `fn` returns or throws.
 */
export async function withAgentRequest<T>(
  authorizationHeader: string | null,
  fn: (ctx: AgentRequestContext) => Promise<T>,
  opts?: { expectedResource?: string },
): Promise<T> {
  const token = parseBearer(authorizationHeader);
  if (!token) throw new AgentAuthError("missing bearer token");

  if (token.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)) {
    const verified = await validateAccessToken(token, opts?.expectedResource);
    if (!verified) throw new AgentAuthError("invalid or expired token");
    try {
      return await fn({
        userId: verified.userId,
        tokenId: verified.grantId,
        credentialKind: "oauth-grant",
        dataKey: verified.dataKey,
      });
    } finally {
      wipe(verified.dataKey);
    }
  }

  const verified = await verifyAndUnwrapDk(token);
  if (!verified) throw new AgentAuthError("invalid or expired token");
  try {
    return await fn({
      userId: verified.userId,
      tokenId: verified.tokenId,
      dataKey: verified.dataKey,
    });
  } finally {
    wipe(verified.dataKey);
  }
}
