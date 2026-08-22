import { afterAll, describe, expect, it } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createUser } from "@/domain/registration";
import { updateProfile } from "@/domain/profile";
import { AgentAccessDisabledError } from "@/domain/agent-token";
import {
  createAuthCode,
  exchangeAuthCode,
  listGrants,
  mintAccessToken,
  refreshGrant,
  revokeGrant,
  validateAccessToken,
} from "@/domain/mcp-oauth";
import { wipe } from "@/lib/crypto";
import { cleanupOwners } from "./helpers";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN;
if (!SIGNUP_TOKEN) {
  throw new Error("MONI_SIGNUP_TOKEN must be set in the test environment (see .env.example)");
}

const PASSWORD = "correct horse battery staple";
const CLIENT_ID = "https://claude.ai/.well-known/oauth-client";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const SCOPE = "mcp:read offline_access";

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier, "ascii").digest("base64url"),
  };
}

describe("domain/mcp-oauth", () => {
  const createdUserIds: string[] = [];
  afterAll(async () => cleanupOwners(createdUserIds));

  async function user(
    label: string,
    opts: { agentAccess?: boolean } = {},
  ): Promise<{ userId: string; dataKey: Buffer }> {
    const { userId, dataKey } = await createUser(
      `${label}-${randomUUID()}@test.moni`,
      Buffer.from(PASSWORD, "utf8"),
      SIGNUP_TOKEN!,
    );
    createdUserIds.push(userId);
    if (opts.agentAccess !== false) await updateProfile(userId, { agentAccessEnabled: true });
    return { userId, dataKey };
  }

  async function authorizeAndExchange(userId: string, dataKey: Buffer) {
    const { verifier, challenge } = pkce();
    const { code } = await createAuthCode(userId, dataKey, {
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scope: SCOPE,
      codeChallenge: challenge,
    });
    const result = await exchangeAuthCode(code, verifier, {
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
    });
    if (!result.ok) throw new Error(`test setup: exchange failed (${result.error})`);
    return result;
  }

  it("exchanges a PKCE-bound authorization code for tokens that yield the user's DK", async () => {
    const { userId, dataKey } = await user("oauth-roundtrip");
    const { verifier, challenge } = pkce();
    const { code } = await createAuthCode(userId, dataKey, {
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scope: SCOPE,
      codeChallenge: challenge,
    });

    const exchanged = await exchangeAuthCode(code, verifier, {
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
    });
    expect(exchanged.ok).toBe(true);
    if (!exchanged.ok) return;
    expect(exchanged.tokenType).toBe("Bearer");
    expect(exchanged.scope).toBe(SCOPE);
    expect(exchanged.accessToken).toMatch(/^moni_oauth_at_/);
    expect(exchanged.refreshToken).toMatch(/^moni_oauth_rt_/);

    const verified = await validateAccessToken(exchanged.accessToken);
    expect(verified).not.toBeNull();
    expect(verified!.userId).toBe(userId);
    expect(verified!.dataKey.equals(dataKey)).toBe(true);
    wipe(verified!.dataKey);
  });

  it("rejects an access token whose authenticated expiry was edited", async () => {
    const { userId, dataKey } = await user("oauth-tampered-expiry");
    const exchanged = await authorizeAndExchange(userId, dataKey);
    const prefix = "moni_oauth_at_";
    const packed = Buffer.from(exchanged.accessToken.slice(prefix.length), "base64url");
    packed.writeBigUInt64BE(packed.readBigUInt64BE(17) + 60n, 17);

    expect(await validateAccessToken(prefix + packed.toString("base64url"))).toBeNull();
  });

  it("rejects an expired access token", async () => {
    const { userId, dataKey } = await user("oauth-expired-access");
    await authorizeAndExchange(userId, dataKey);
    const [grant] = await listGrants(userId);
    const expired = mintAccessToken(grant.id, dataKey, -1_000);
    expect(await validateAccessToken(expired.token)).toBeNull();
  });

  it("refreshes without a password and rotates the refresh token", async () => {
    const { userId, dataKey } = await user("oauth-refresh");
    const exchanged = await authorizeAndExchange(userId, dataKey);

    const refreshed = await refreshGrant(exchanged.refreshToken);
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) return;
    expect(refreshed.refreshToken).not.toBe(exchanged.refreshToken);
    expect(await refreshGrant(exchanged.refreshToken)).toEqual({
      ok: false,
      error: "invalid_grant",
    });

    const verified = await validateAccessToken(refreshed.accessToken);
    expect(verified?.userId).toBe(userId);
    expect(verified?.dataKey.equals(dataKey)).toBe(true);
    wipe(verified!.dataKey);
  });

  it("allows only one winner when the same refresh token is used concurrently", async () => {
    const { userId, dataKey } = await user("oauth-refresh-race");
    const exchanged = await authorizeAndExchange(userId, dataKey);

    const results = await Promise.all([
      refreshGrant(exchanged.refreshToken),
      refreshGrant(exchanged.refreshToken),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.error === "invalid_grant")).toHaveLength(
      1,
    );
  });

  it("does not consume a code on PKCE failure, then consumes it exactly once", async () => {
    const { userId, dataKey } = await user("oauth-code-once");
    const { verifier, challenge } = pkce();
    const { code } = await createAuthCode(userId, dataKey, {
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scope: SCOPE,
      codeChallenge: challenge,
    });
    const wrongVerifier = randomBytes(32).toString("base64url");

    expect(
      await exchangeAuthCode(code, wrongVerifier, {
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
      }),
    ).toEqual({ ok: false, error: "invalid_grant" });
    expect(
      (
        await exchangeAuthCode(code, verifier, {
          clientId: CLIENT_ID,
          redirectUri: REDIRECT_URI,
        })
      ).ok,
    ).toBe(true);
    expect(
      await exchangeAuthCode(code, verifier, {
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
      }),
    ).toEqual({ ok: false, error: "invalid_grant" });
  });

  it("allows only one winner when the same authorization code is exchanged concurrently", async () => {
    const { userId, dataKey } = await user("oauth-code-race");
    const { verifier, challenge } = pkce();
    const { code } = await createAuthCode(userId, dataKey, {
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scope: SCOPE,
      codeChallenge: challenge,
    });
    const client = { clientId: CLIENT_ID, redirectUri: REDIRECT_URI };

    const results = await Promise.all([
      exchangeAuthCode(code, verifier, client),
      exchangeAuthCode(code, verifier, client),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.error === "invalid_grant")).toHaveLength(
      1,
    );
  });

  it("revocation immediately kills access and refresh tokens", async () => {
    const { userId, dataKey } = await user("oauth-revoke");
    const exchanged = await authorizeAndExchange(userId, dataKey);
    const [grant] = await listGrants(userId);
    expect(await revokeGrant(userId, grant.id)).toBe(true);
    expect(await revokeGrant(userId, grant.id)).toBe(false);
    expect(await validateAccessToken(exchanged.accessToken)).toBeNull();
    expect(await refreshGrant(exchanged.refreshToken)).toEqual({
      ok: false,
      error: "invalid_grant",
    });
  });

  it("the agent-access opt-in gates issuance, access, and refresh", async () => {
    const optedOut = await user("oauth-optout-create", { agentAccess: false });
    const { challenge } = pkce();
    await expect(
      createAuthCode(optedOut.userId, optedOut.dataKey, {
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        scope: SCOPE,
        codeChallenge: challenge,
      }),
    ).rejects.toBeInstanceOf(AgentAccessDisabledError);

    const active = await user("oauth-optout-existing");
    const exchanged = await authorizeAndExchange(active.userId, active.dataKey);
    await updateProfile(active.userId, { agentAccessEnabled: false });
    expect(await validateAccessToken(exchanged.accessToken)).toBeNull();
    expect(await refreshGrant(exchanged.refreshToken)).toEqual({
      ok: false,
      error: "invalid_grant",
    });
  });

  it("keeps grant listing and revocation tenant-isolated", async () => {
    const a = await user("oauth-tenant-a");
    const b = await user("oauth-tenant-b");
    const exchanged = await authorizeAndExchange(a.userId, a.dataKey);
    const [grant] = await listGrants(a.userId);

    expect(await listGrants(b.userId)).toEqual([]);
    expect(await revokeGrant(b.userId, grant.id)).toBe(false);
    const verified = await validateAccessToken(exchanged.accessToken);
    expect(verified?.userId).toBe(a.userId);
    wipe(verified!.dataKey);
  });
});
