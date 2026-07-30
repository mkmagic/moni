// src/domain/credential-unlock.ts (issue #7) — the credential key (CK) is
// reachable ONLY through an enrolled second factor, never through the login
// password.
//
// Every test here drives the production path with an opaque 32-byte unlock
// secret, exactly as the route edge does after a WebAuthn assertion. There
// is no test-only branch in the domain layer: the domain does not know what
// WebAuthn is, which is precisely what makes this file possible.
import { afterAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { withUser } from "@/db/client";
import * as schema from "@/db/schema";
import { createUser } from "@/domain/registration";
import { authenticate } from "@/domain/auth";
import {
  CredentialKeyRequiredError,
  PasskeyAlreadyEnrolledError,
  UNLOCK_SECRET_LENGTH,
  enrollCredentialUnlockMethod,
  listCredentialUnlockMethods,
  recordAssertionCounter,
  unlockCredentialKey,
  type PasskeyUnlockRef,
} from "@/domain/credential-unlock";
import { cleanupOwners } from "./helpers";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN;
if (!SIGNUP_TOKEN) {
  throw new Error("MONI_SIGNUP_TOKEN must be set in the test environment (see .env.example)");
}

const PASSWORD = "correct horse battery staple";

function passkeyRef(overrides: Partial<PasskeyUnlockRef> = {}): PasskeyUnlockRef {
  return {
    credentialIdB64Url: randomBytes(16).toString("base64url"),
    publicKeyB64Url: randomBytes(64).toString("base64url"),
    counter: 0,
    transports: ["internal", "hybrid"],
    rpId: "localhost",
    label: "Test passkey",
    ...overrides,
  };
}

async function freshUser(label: string): Promise<string> {
  const email = `${label}-${randomUUID()}@test.moni`;
  const { userId } = await createUser(email, Buffer.from(PASSWORD, "utf8"), SIGNUP_TOKEN!);
  return userId;
}

describe("domain/credential-unlock", () => {
  const createdUserIds: string[] = [];
  afterAll(async () => cleanupOwners(createdUserIds));

  async function user(label: string): Promise<string> {
    const userId = await freshUser(label);
    createdUserIds.push(userId);
    return userId;
  }

  it("a fresh user has no credential unlock method and therefore no CK at all", async () => {
    const userId = await user("cu-fresh");
    expect(await listCredentialUnlockMethods(userId)).toEqual([]);

    // The password method exists, and it wraps DK ONLY — the whole point of
    // #18's requirement. A row that could open CK from the password is the
    // failure this asserts against.
    await withUser(userId, async (tx) => {
      const rows = await tx.select().from(schema.userUnlockMethods);
      expect(rows).toHaveLength(1);
      expect(rows[0].type).toBe("password-argon2id");
      expect(rows[0].wrappedDataKey).not.toBeNull();
      expect(rows[0].wrappedCredentialKey).toBeNull();
    });
  });

  it("the login password still opens the session (DK) after CK is split off", async () => {
    const userId = await user("cu-login-still-works");
    expect(userId).toBeTruthy();
    const email = (
      await withUser(userId, async (tx) =>
        tx.select().from(schema.users).where(eq(schema.users.id, userId)),
      )
    )[0].email;
    expect(await authenticate(email, Buffer.from(PASSWORD, "utf8"))).not.toBeNull();
  });

  it("first enrollment mints CK, and the same secret unwraps it again", async () => {
    const userId = await user("cu-first");
    const secret = randomBytes(UNLOCK_SECRET_LENGTH);

    const { methodId, credentialKey } = await enrollCredentialUnlockMethod(
      userId,
      secret,
      passkeyRef(),
      null,
    );
    expect(credentialKey).toHaveLength(32);

    const unlocked = await unlockCredentialKey(userId, methodId, secret);
    expect(unlocked).not.toBeNull();
    expect(unlocked!.equals(credentialKey)).toBe(true);
  });

  it("the enrolled row wraps CK only — never DK", async () => {
    const userId = await user("cu-ck-only");
    const { methodId } = await enrollCredentialUnlockMethod(
      userId,
      randomBytes(UNLOCK_SECRET_LENGTH),
      passkeyRef(),
      null,
    );

    await withUser(userId, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.userUnlockMethods)
        .where(eq(schema.userUnlockMethods.id, methodId));
      expect(rows[0].type).toBe("webauthn-prf");
      expect(rows[0].wrappedCredentialKey).not.toBeNull();
      expect(rows[0].wrappedDataKey).toBeNull();
    });
  });

  it("a wrong unlock secret returns null rather than throwing", async () => {
    const userId = await user("cu-wrong-secret");
    const { methodId } = await enrollCredentialUnlockMethod(
      userId,
      randomBytes(UNLOCK_SECRET_LENGTH),
      passkeyRef(),
      null,
    );
    expect(
      await unlockCredentialKey(userId, methodId, randomBytes(UNLOCK_SECRET_LENGTH)),
    ).toBeNull();
  });

  it("an unknown method id returns null", async () => {
    const userId = await user("cu-unknown-method");
    expect(
      await unlockCredentialKey(userId, randomUUID(), randomBytes(UNLOCK_SECRET_LENGTH)),
    ).toBeNull();
  });

  it("a second passkey wraps the SAME CK, so either one opens the bank credentials", async () => {
    const userId = await user("cu-second");
    const firstSecret = randomBytes(UNLOCK_SECRET_LENGTH);
    const first = await enrollCredentialUnlockMethod(userId, firstSecret, passkeyRef(), null);

    const secondSecret = randomBytes(UNLOCK_SECRET_LENGTH);
    const second = await enrollCredentialUnlockMethod(
      userId,
      secondSecret,
      passkeyRef({ label: "Second ecosystem" }),
      first.credentialKey,
    );

    const viaSecond = await unlockCredentialKey(userId, second.methodId, secondSecret);
    expect(viaSecond).not.toBeNull();
    expect(viaSecond!.equals(first.credentialKey)).toBe(true);

    const methods = await listCredentialUnlockMethods(userId);
    expect(methods.map((m) => m.id).sort()).toEqual([first.methodId, second.methodId].sort());
  });

  it("enrolling a second passkey without the armed CK is refused — never mints a second CK", async () => {
    const userId = await user("cu-second-unarmed");
    await enrollCredentialUnlockMethod(
      userId,
      randomBytes(UNLOCK_SECRET_LENGTH),
      passkeyRef(),
      null,
    );

    await expect(
      enrollCredentialUnlockMethod(userId, randomBytes(UNLOCK_SECRET_LENGTH), passkeyRef(), null),
    ).rejects.toBeInstanceOf(CredentialKeyRequiredError);

    expect(await listCredentialUnlockMethods(userId)).toHaveLength(1);
  });

  it("refuses to enroll the same credential id twice", async () => {
    const userId = await user("cu-dup");
    const ref = passkeyRef();
    const first = await enrollCredentialUnlockMethod(
      userId,
      randomBytes(UNLOCK_SECRET_LENGTH),
      ref,
      null,
    );

    await expect(
      enrollCredentialUnlockMethod(
        userId,
        randomBytes(UNLOCK_SECRET_LENGTH),
        passkeyRef({ credentialIdB64Url: ref.credentialIdB64Url }),
        first.credentialKey,
      ),
    ).rejects.toBeInstanceOf(PasskeyAlreadyEnrolledError);
  });

  it("stores the wrapped CK as opaque ciphertext — the key is not in the stored bytes", async () => {
    const userId = await user("cu-opaque");
    const { methodId, credentialKey } = await enrollCredentialUnlockMethod(
      userId,
      randomBytes(UNLOCK_SECRET_LENGTH),
      passkeyRef(),
      null,
    );

    await withUser(userId, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.userUnlockMethods)
        .where(eq(schema.userUnlockMethods.id, methodId));
      const stored = Buffer.from(rows[0].wrappedCredentialKey!);
      expect(stored.includes(credentialKey)).toBe(false);
    });
  });

  it("cross-tenant: user B cannot unlock via user A's method id", async () => {
    const a = await user("cu-a");
    const b = await user("cu-b");
    const secret = randomBytes(UNLOCK_SECRET_LENGTH);
    const { methodId } = await enrollCredentialUnlockMethod(a, secret, passkeyRef(), null);

    expect(await unlockCredentialKey(b, methodId, secret)).toBeNull();
    expect(await listCredentialUnlockMethods(b)).toEqual([]);
  });

  it("records an advanced signature counter, and never regresses it", async () => {
    const userId = await user("cu-counter");
    const { methodId } = await enrollCredentialUnlockMethod(
      userId,
      randomBytes(UNLOCK_SECRET_LENGTH),
      passkeyRef({ counter: 0 }),
      null,
    );

    await recordAssertionCounter(userId, methodId, 7);
    expect((await listCredentialUnlockMethods(userId))[0].ref.counter).toBe(7);

    await recordAssertionCounter(userId, methodId, 3);
    expect((await listCredentialUnlockMethods(userId))[0].ref.counter).toBe(7);
  });
});
