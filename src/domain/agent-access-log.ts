// Agent access log + per-token rate cap (issue #113 Phase 4, docs/design/
// mcp-and-api.md §7, threat-model §9).
//
// Every agent-token tool call appends one row here recording what was *asked* —
// the tool, the *shape* of its arguments, and the row count it returned — never
// what was *returned*. That visibility is the countermeasure to the dominant
// residual risk (a prompt-injected model quietly sweeping the whole ledger):
// an anomalous run of calls is legible after the fact, and the same rows are
// what the per-token rate cap counts against so a runaway sweep trips a limit.
//
// NEVER plaintext. `argShape` is a `{ argName: jsType }` map, deliberately not
// the argument values — a `category`/`merchant` filter value would be Tier-1
// plaintext. Nothing decrypted, no secret, no amount is ever written here.
import { and, count, eq, gte } from "drizzle-orm";
import { withUser } from "@/db/client";
import { agentAccessLog } from "@/db/schema";

/** Per-token call caps. Not a security row cap (there is none — threat-model
 * §5.6/§9): these are generous burst/volume backstops that trip a runaway
 * sweep and make it visible. Real control stays audit-visibility + revoke. */
export const RATE_CAP_PER_MINUTE = 120;
export const RATE_CAP_PER_DAY = 10_000;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** Thrown when a token exceeds a call cap. The route maps it to an MCP error. */
export class AgentAccessCapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentAccessCapError";
  }
}

/** JS-type shape of a tool's arguments — keys and types only, never values. */
export function argShapeOf(args: Record<string, unknown>): Record<string, string> {
  const shape: Record<string, string> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue; // an absent optional arg is not part of the shape
    shape[k] = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
  }
  return shape;
}

async function callsSince(userId: string, tokenId: string, since: Date): Promise<number> {
  return withUser(userId, async (tx) => {
    const [row] = await tx
      .select({ n: count() })
      .from(agentAccessLog)
      .where(and(eq(agentAccessLog.tokenId, tokenId), gte(agentAccessLog.createdAt, since)));
    return row?.n ?? 0;
  });
}

/**
 * Throws {@link AgentAccessCapError} if this token has already hit a cap in the
 * trailing window. Counts the audit log itself — an appended row is a call that
 * happened — so the cap is consistent across processes and survives a restart.
 */
export async function assertUnderRateCap(userId: string, tokenId: string): Promise<void> {
  const now = Date.now();
  const perDay = await callsSince(userId, tokenId, new Date(now - DAY_MS));
  if (perDay >= RATE_CAP_PER_DAY) {
    throw new AgentAccessCapError("daily call cap exceeded for this token");
  }
  const perMinute = await callsSince(userId, tokenId, new Date(now - MINUTE_MS));
  if (perMinute >= RATE_CAP_PER_MINUTE) {
    throw new AgentAccessCapError("per-minute call cap exceeded for this token");
  }
}

/** Appends one audit row for a completed tool call. */
export async function recordAccess(
  userId: string,
  entry: { tokenId: string; tool: string; argShape: Record<string, string>; rowCount: number },
): Promise<void> {
  await withUser(userId, async (tx) => {
    await tx.insert(agentAccessLog).values({
      ownerId: userId,
      tokenId: entry.tokenId,
      tool: entry.tool,
      argShape: entry.argShape,
      rowCount: entry.rowCount,
    });
  });
}
