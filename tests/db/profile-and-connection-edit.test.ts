// src/domain/profile.ts and the connection-edit half of
// src/domain/connections.ts (rename + replace credentials).
//
// The load-bearing case here is the row-version trap (docs plan §E.2): a
// rename must NOT bump `connections.version`, because the version is shared
// by every ciphertext column on the row and `credentials_ct`'s AAD is bound
// to it. Getting that backwards leaves credentials that silently fail to
// decrypt — no error until the next scrape.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createUser } from "@/domain/registration";
import { authenticate, unlockCredentialKey } from "@/domain/auth";
import { getSession } from "@/lib/auth/session-store";
import {
  createConnection,
  getDecryptedCredentials,
  renameConnection,
  updateConnectionCredentials,
} from "@/domain/connections";
import { getProfile, updateProfile } from "@/domain/profile";
import { cleanupOwners, elevatedPool } from "./helpers";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN;
if (!SIGNUP_TOKEN) {
  throw new Error("MONI_SIGNUP_TOKEN must be set in the test environment (see .env.example)");
}

const PASSWORD = "correct horse battery staple";

async function freshUser(label: string): Promise<{ userId: string; credentialKey: Buffer }> {
  const email = `${label}-${randomUUID()}@test.moni`;
  const password = Buffer.from(PASSWORD, "utf8");
  const { userId } = await createUser(email, password, SIGNUP_TOKEN!);
  const credentialKey = await unlockCredentialKey(userId, password);
  if (!credentialKey) throw new Error("test setup: failed to unlock credential key");
  return { userId, credentialKey };
}

describe("domain/profile", () => {
  const createdUserIds: string[] = [];
  afterAll(async () => cleanupOwners(createdUserIds));

  it("defaults to no display name and auto-sync off", async () => {
    const { userId } = await freshUser("profile-defaults");
    createdUserIds.push(userId);

    const profile = await getProfile(userId);
    expect(profile).not.toBeNull();
    expect(profile!.displayName).toBeNull();
    expect(profile!.autoSyncOnLogin).toBe(false);
    expect(profile!.baseCurrency).toBe("ILS");
  });

  it("updates each field independently — a preference toggle can't blank the name", async () => {
    const { userId } = await freshUser("profile-partial");
    createdUserIds.push(userId);

    await updateProfile(userId, { displayName: "  Michael  " });
    expect((await getProfile(userId))!.displayName).toBe("Michael");

    await updateProfile(userId, { autoSyncOnLogin: true });
    const after = await getProfile(userId);
    expect(after!.displayName).toBe("Michael");
    expect(after!.autoSyncOnLogin).toBe(true);
  });

  it("treats an empty/whitespace name as clearing it", async () => {
    const { userId } = await freshUser("profile-clear");
    createdUserIds.push(userId);

    await updateProfile(userId, { displayName: "Michael" });
    await updateProfile(userId, { displayName: "   " });
    expect((await getProfile(userId))!.displayName).toBeNull();
  });

  it("is RLS-scoped — one user's update never touches another's row", async () => {
    const mine = await freshUser("profile-mine");
    const theirs = await freshUser("profile-theirs");
    createdUserIds.push(mine.userId, theirs.userId);

    await updateProfile(mine.userId, { displayName: "Mine", autoSyncOnLogin: true });

    const other = await getProfile(theirs.userId);
    expect(other!.displayName).toBeNull();
    expect(other!.autoSyncOnLogin).toBe(false);
  });
});

describe("domain/auth — login sync offer (promptSyncOnLogin)", () => {
  const createdUserIds: string[] = [];
  afterAll(async () => cleanupOwners(createdUserIds));

  /** Logs in and returns the resulting session. */
  async function login(email: string) {
    const password = Buffer.from(PASSWORD, "utf8");
    const sessionId = await authenticate(email, password);
    if (!sessionId) throw new Error("test setup: authenticate() failed");
    const session = getSession(sessionId);
    if (!session) throw new Error("test setup: session vanished");
    return session;
  }

  async function backdateLastLogin(userId: string, hoursAgo: number): Promise<void> {
    await elevatedPool.query(
      `update users set last_login_at = now() - ($2 || ' hours')::interval where id = $1`,
      [userId, hoursAgo],
    );
  }

  it("is false on a first-ever login, even with the preference on (no previous login to measure)", async () => {
    const email = `sync-first-${randomUUID()}@test.moni`;
    const password = Buffer.from(PASSWORD, "utf8");
    const { userId } = await createUser(email, password, SIGNUP_TOKEN!);
    createdUserIds.push(userId);
    await updateProfile(userId, { autoSyncOnLogin: true });

    expect((await login(email)).promptSyncOnLogin).toBe(false);
  });

  it("is false when the preference is off, however long the gap", async () => {
    const email = `sync-off-${randomUUID()}@test.moni`;
    const password = Buffer.from(PASSWORD, "utf8");
    const { userId } = await createUser(email, password, SIGNUP_TOKEN!);
    createdUserIds.push(userId);

    await login(email); // records last_login_at
    await backdateLastLogin(userId, 48);
    expect((await login(email)).promptSyncOnLogin).toBe(false);
  });

  it("is false when the preference is on but the gap is under 8 hours", async () => {
    const email = `sync-recent-${randomUUID()}@test.moni`;
    const password = Buffer.from(PASSWORD, "utf8");
    const { userId } = await createUser(email, password, SIGNUP_TOKEN!);
    createdUserIds.push(userId);
    await updateProfile(userId, { autoSyncOnLogin: true });

    await login(email);
    await backdateLastLogin(userId, 3);
    expect((await login(email)).promptSyncOnLogin).toBe(false);
  });

  it("is TRUE when the preference is on and the previous login was over 8 hours ago", async () => {
    const email = `sync-stale-${randomUUID()}@test.moni`;
    const password = Buffer.from(PASSWORD, "utf8");
    const { userId } = await createUser(email, password, SIGNUP_TOKEN!);
    createdUserIds.push(userId);
    await updateProfile(userId, { autoSyncOnLogin: true });

    await login(email);
    await backdateLastLogin(userId, 9);
    expect((await login(email)).promptSyncOnLogin).toBe(true);
  });

  it("records last_login_at on every successful login", async () => {
    const email = `sync-stamp-${randomUUID()}@test.moni`;
    const password = Buffer.from(PASSWORD, "utf8");
    const { userId } = await createUser(email, password, SIGNUP_TOKEN!);
    createdUserIds.push(userId);

    const before = await elevatedPool.query<{ last_login_at: Date | null }>(
      `select last_login_at from users where id = $1`,
      [userId],
    );
    expect(before.rows[0].last_login_at).toBeNull();

    await login(email);

    const after = await elevatedPool.query<{ last_login_at: Date | null }>(
      `select last_login_at from users where id = $1`,
      [userId],
    );
    expect(after.rows[0].last_login_at).not.toBeNull();
  });
});

describe("domain/connections — edit", () => {
  const createdUserIds: string[] = [];
  afterAll(async () => cleanupOwners(createdUserIds));

  it("rename leaves stored credentials decryptable (must NOT bump the row version)", async () => {
    const { userId, credentialKey } = await freshUser("conn-rename");
    createdUserIds.push(userId);
    const { id } = await createConnection(
      userId,
      "leumi",
      { username: "kanon01", password: "hunter2" },
      credentialKey,
      "Original",
    );

    const renamed = await renameConnection(userId, id, "Everyday account");
    expect(renamed).toBe(true);

    // The trap: if rename bumped `version`, this decrypt fails.
    const decrypted = await getDecryptedCredentials(userId, id, credentialKey);
    expect(decrypted!.credentials).toEqual({ username: "kanon01", password: "hunter2" });
  });

  it("replaces credentials and they decrypt at the bumped version", async () => {
    const { userId, credentialKey } = await freshUser("conn-recred");
    createdUserIds.push(userId);
    const { id } = await createConnection(
      userId,
      "leumi",
      { username: "typo", password: "wrong" },
      credentialKey,
    );

    const updated = await updateConnectionCredentials(
      userId,
      id,
      { username: "kanon01", password: "right" },
      credentialKey,
    );
    expect(updated).toBe(true);

    const decrypted = await getDecryptedCredentials(userId, id, credentialKey);
    expect(decrypted!.credentials).toEqual({ username: "kanon01", password: "right" });
  });

  it("survives a rename after a credential replacement (version bumped once, still consistent)", async () => {
    const { userId, credentialKey } = await freshUser("conn-both");
    createdUserIds.push(userId);
    const { id } = await createConnection(
      userId,
      "leumi",
      { username: "a", password: "b" },
      credentialKey,
    );

    await updateConnectionCredentials(userId, id, { username: "c", password: "d" }, credentialKey);
    await renameConnection(userId, id, "After both");

    const decrypted = await getDecryptedCredentials(userId, id, credentialKey);
    expect(decrypted!.credentials).toEqual({ username: "c", password: "d" });
  });

  it("rejects credentials whose keys don't match the connector's login fields", async () => {
    const { userId, credentialKey } = await freshUser("conn-shape");
    createdUserIds.push(userId);
    const { id } = await createConnection(
      userId,
      "leumi",
      { username: "a", password: "b" },
      credentialKey,
    );

    await expect(
      updateConnectionCredentials(userId, id, { userCode: "a", password: "b" }, credentialKey),
    ).rejects.toThrow();
  });

  it("is RLS-scoped — editing another user's connection reports not-found", async () => {
    const mine = await freshUser("conn-edit-mine");
    const theirs = await freshUser("conn-edit-theirs");
    createdUserIds.push(mine.userId, theirs.userId);
    const { id } = await createConnection(
      theirs.userId,
      "leumi",
      { username: "a", password: "b" },
      theirs.credentialKey,
    );

    expect(await renameConnection(mine.userId, id, "hijacked")).toBe(false);
    expect(
      await updateConnectionCredentials(
        mine.userId,
        id,
        { username: "x", password: "y" },
        mine.credentialKey,
      ),
    ).toBe(false);

    // Untouched.
    const decrypted = await getDecryptedCredentials(theirs.userId, id, theirs.credentialKey);
    expect(decrypted!.credentials).toEqual({ username: "a", password: "b" });
  });
});
