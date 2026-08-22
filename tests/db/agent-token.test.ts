// src/domain/agent-token.ts (issue #113) — a per-user agent token round-trips
// the user's data key (DK) for one request, fails closed when expired/revoked/
// wrong, and can NEVER reach the credential key (CK).
//
// Like credential-unlock.test.ts, every test drives the production path with
// opaque random bytes — the token secret is the seam, and no test-only branch
// exists in the domain layer.
import { afterAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { withUser } from "@/db/client";
import * as schema from "@/db/schema";
import { createUser } from "@/domain/registration";
import { updateProfile } from "@/domain/profile";
import {
  AgentAccessDisabledError,
  DEFAULT_TOKEN_TTL_MS,
  listTokens,
  mintToken,
  revokeToken,
  rotateToken,
  verifyAndUnwrapDk,
} from "@/domain/agent-token";
import { cleanupOwners, enrollTestCredentialKey } from "./helpers";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN;
if (!SIGNUP_TOKEN) {
  throw new Error("MONI_SIGNUP_TOKEN must be set in the test environment (see .env.example)");
}

const PASSWORD = "correct horse battery staple";

describe("domain/agent-token", () => {
  const createdUserIds: string[] = [];
  afterAll(async () => cleanupOwners(createdUserIds));

  async function user(
    label: string,
    opts: { agentAccess?: boolean } = {},
  ): Promise<{ userId: string; dataKey: Buffer }> {
    const email = `${label}-${randomUUID()}@test.moni`;
    const { userId, dataKey } = await createUser(
      email,
      Buffer.from(PASSWORD, "utf8"),
      SIGNUP_TOKEN!,
    );
    createdUserIds.push(userId);
    // Agent access is opt-in (Phase 5); on by default here so the round-trip
    // tests can mint. The opt-in tests below pass `{ agentAccess: false }`.
    if (opts.agentAccess !== false) await updateProfile(userId, { agentAccessEnabled: true });
    return { userId, dataKey };
  }

  it("mints a token whose secret unwraps the same DK, for the same user", async () => {
    const { userId, dataKey } = await user("at-roundtrip");
    const { secret } = await mintToken(userId, dataKey, { label: "phone" });

    const verified = await verifyAndUnwrapDk(secret);
    expect(verified).not.toBeNull();
    expect(verified!.userId).toBe(userId);
    expect(verified!.dataKey.equals(dataKey)).toBe(true);

    // Default TTL is the 90-day backstop.
    const [row] = await listTokens(userId);
    expect(row.expiresAt!.getTime() - row.createdAt.getTime()).toBeCloseTo(
      DEFAULT_TOKEN_TTL_MS,
      -4,
    );
  });

  it("mints a never-expiring token (ttlMs null) that keeps verifying", async () => {
    const { userId, dataKey } = await user("at-never");
    const minted = await mintToken(userId, dataKey, { ttlMs: null });
    expect(minted.expiresAt).toBeNull();

    const [row] = await listTokens(userId);
    expect(row.expiresAt).toBeNull();

    // No backstop to trip — it verifies.
    const verified = await verifyAndUnwrapDk(minted.secret);
    expect(verified).not.toBeNull();
    expect(verified!.dataKey.equals(dataKey)).toBe(true);
  });

  it("stores the token hashed and DK wrapped — neither plaintext is in the row", async () => {
    const { userId, dataKey } = await user("at-hashed");
    const { tokenId, secret } = await mintToken(userId, dataKey);

    await withUser(userId, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.agentTokens)
        .where(eq(schema.agentTokens.id, tokenId));
      const stored = rows[0];
      // token_hash is a SHA-256, not the secret bytes.
      expect(stored.tokenHash).toHaveLength(32);
      expect(Buffer.from(stored.tokenHash).toString("base64url")).not.toBe(
        secret.slice("moni_agent_".length),
      );
      // wrapped_dk is opaque ciphertext — the DK is not in the stored bytes.
      expect(Buffer.from(stored.wrappedDk).includes(dataKey)).toBe(false);
    });
  });

  it("bumps last_used_at on a successful verify", async () => {
    const { userId, dataKey } = await user("at-lastused");
    const { secret } = await mintToken(userId, dataKey);

    expect((await listTokens(userId))[0].lastUsedAt).toBeNull();
    await verifyAndUnwrapDk(secret);
    expect((await listTokens(userId))[0].lastUsedAt).not.toBeNull();
  });

  it("rejects a malformed, wrong-length, or wrong-secret token", async () => {
    const { userId, dataKey } = await user("at-bad");
    await mintToken(userId, dataKey);

    expect(await verifyAndUnwrapDk("not-a-moni-token")).toBeNull();
    expect(await verifyAndUnwrapDk("moni_agent_" + "AAAA")).toBeNull(); // wrong length
    // Right shape, right length, wrong bytes → AEAD auth failure → null.
    expect(
      await verifyAndUnwrapDk("moni_agent_" + randomBytes(32).toString("base64url")),
    ).toBeNull();
  });

  it("fails closed on an expired token", async () => {
    const { userId, dataKey } = await user("at-expired");
    const { secret } = await mintToken(userId, dataKey, { ttlMs: -1000 });
    expect(await verifyAndUnwrapDk(secret)).toBeNull();
  });

  it("fails closed once revoked; revoke is idempotent", async () => {
    const { userId, dataKey } = await user("at-revoked");
    const { tokenId, secret } = await mintToken(userId, dataKey);

    expect(await verifyAndUnwrapDk(secret)).not.toBeNull();
    expect(await revokeToken(userId, tokenId)).toBe(true);
    expect(await verifyAndUnwrapDk(secret)).toBeNull();
    // Second revoke is a no-op (already dead).
    expect(await revokeToken(userId, tokenId)).toBe(false);
  });

  it("no token path can reach CK — a token yields DK, never the credential key", async () => {
    const { userId, dataKey } = await user("at-ck-unreachable");
    // Give the user a real CK via the production enrollment path.
    const credentialKey = await enrollTestCredentialKey(userId);

    const { secret } = await mintToken(userId, dataKey);
    const verified = await verifyAndUnwrapDk(secret);
    expect(verified).not.toBeNull();
    // The token unwraps DK, and DK is not CK.
    expect(verified!.dataKey.equals(dataKey)).toBe(true);
    expect(verified!.dataKey.equals(credentialKey)).toBe(false);

    // Structural: the agent_tokens row carries no credential-key material at
    // all — there is nowhere for a CK to live on this surface.
    await withUser(userId, async (tx) => {
      const rows = await tx.select().from(schema.agentTokens);
      expect(rows).toHaveLength(1);
      expect(Object.keys(rows[0])).not.toContain("wrappedCredentialKey");
    });
  });

  it("cross-tenant: user B cannot see or revoke user A's token, and A's token yields only A's DK", async () => {
    const a = await user("at-a");
    const b = await user("at-b");
    const { tokenId, secret } = await mintToken(a.userId, a.dataKey);

    // B's user-scoped views never surface A's token.
    expect(await listTokens(b.userId)).toEqual([]);
    expect(await revokeToken(b.userId, tokenId)).toBe(false);

    // A's token still resolves to A and yields A's DK — B's revoke did nothing.
    const verified = await verifyAndUnwrapDk(secret);
    expect(verified!.userId).toBe(a.userId);
    expect(verified!.dataKey.equals(a.dataKey)).toBe(true);
    expect(verified!.dataKey.equals(b.dataKey)).toBe(false);
  });

  // --- Phase 5: per-user opt-in as a master kill switch ---

  it("refuses to mint when the user has not opted into agent access", async () => {
    const { userId, dataKey } = await user("at-optout-mint", { agentAccess: false });
    await expect(mintToken(userId, dataKey)).rejects.toBeInstanceOf(AgentAccessDisabledError);
    expect(await listTokens(userId)).toEqual([]);
  });

  it("opt-out is a kill switch: an existing token fails closed, and re-opt-in restores it", async () => {
    const { userId, dataKey } = await user("at-killswitch");
    const { secret } = await mintToken(userId, dataKey);
    expect(await verifyAndUnwrapDk(secret)).not.toBeNull();

    // Toggle off — every one of this user's tokens stops verifying at once,
    // without any token being revoked.
    await updateProfile(userId, { agentAccessEnabled: false });
    expect(await verifyAndUnwrapDk(secret)).toBeNull();

    // Toggle back on — the same token works again (it was never revoked).
    await updateProfile(userId, { agentAccessEnabled: true });
    const back = await verifyAndUnwrapDk(secret);
    expect(back).not.toBeNull();
    expect(back!.dataKey.equals(dataKey)).toBe(true);
  });

  it("rotate mints a working replacement and revokes the old token", async () => {
    const { userId, dataKey } = await user("at-rotate");
    const { tokenId, secret: oldSecret } = await mintToken(userId, dataKey, { label: "phone" });

    const rotated = await rotateToken(userId, dataKey, tokenId);
    expect(rotated).not.toBeNull();

    // Old secret is dead; the new one works and yields the same DK.
    expect(await verifyAndUnwrapDk(oldSecret)).toBeNull();
    const verified = await verifyAndUnwrapDk(rotated!.secret);
    expect(verified!.userId).toBe(userId);
    expect(verified!.dataKey.equals(dataKey)).toBe(true);

    // The label carried over, and rotating an already-dead token is a no-op.
    const live = (await listTokens(userId)).filter((t) => t.revokedAt === null);
    expect(live).toHaveLength(1);
    expect(live[0].label).toBe("phone");
    expect(await rotateToken(userId, dataKey, tokenId)).toBeNull();
  });
});
