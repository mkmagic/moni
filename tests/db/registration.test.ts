// createUser() (src/domain/registration.ts) — the one function that mints a
// new user's key custody (docs plan §A2). Exercises it end to end through
// the real login path, checks the data key is genuinely random (never the
// dev key provider), and covers the two fail-closed paths (duplicate email,
// bad signup token) plus cross-tenant isolation on the new
// `user_unlock_methods` table — the same shape as
// docs/design/domain-layer.md §5's cross-tenant test suite.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { withUser } from "@/db/client";
import * as schema from "@/db/schema";
import {
  createUser,
  EmailAlreadyExistsError,
  InvalidSignupTokenError,
} from "@/domain/registration";
import { authenticate } from "@/domain/auth";
import { destroySession, getSession } from "@/lib/auth/session-store";
import { decryptField, encryptField, getDevUserDataKey } from "@/lib/crypto";
import { cleanupOwners } from "./helpers";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN;
if (!SIGNUP_TOKEN) {
  throw new Error("MONI_SIGNUP_TOKEN must be set in the test environment (see .env.example)");
}

function freshEmail(label: string): string {
  return `${label}-${randomUUID()}@test.moni`;
}

describe("createUser(): registration mints real key custody", () => {
  const createdUserIds: string[] = [];
  const createdSessionIds: string[] = [];

  afterAll(async () => {
    for (const id of createdSessionIds) destroySession(id);
    await cleanupOwners(createdUserIds);
  });

  it("registers, authenticates, and decrypts a Tier-1 field end to end", async () => {
    const email = freshEmail("reg");
    const password = Buffer.from("correct horse battery staple", "utf8");

    const { userId, dataKey } = await createUser(email, password, SIGNUP_TOKEN!);
    createdUserIds.push(userId);

    // Encrypt a value with the returned data key, exactly as the domain
    // layer's first write path would (src/domain/fields.ts's encText).
    const rowId = randomUUID();
    const ciphertext = encryptField(dataKey, Buffer.from("Hello, Moni", "utf8"), {
      rowId,
      column: "test_ct",
      version: 1,
    });

    const sessionId = await authenticate(
      email,
      Buffer.from("correct horse battery staple", "utf8"),
    );
    expect(sessionId).not.toBeNull();
    createdSessionIds.push(sessionId!);

    const session = getSession(sessionId!);
    expect(session).not.toBeNull();

    const decrypted = decryptField(session!.dataKey, ciphertext, {
      rowId,
      column: "test_ct",
      version: 1,
    });
    expect(decrypted.toString("utf8")).toBe("Hello, Moni");
  });

  it("two users' data keys differ, and neither equals getDevUserDataKey(id)", async () => {
    const { userId: userIdA, dataKey: dataKeyA } = await createUser(
      freshEmail("dk-a"),
      Buffer.from("password-a", "utf8"),
      SIGNUP_TOKEN!,
    );
    const { userId: userIdB, dataKey: dataKeyB } = await createUser(
      freshEmail("dk-b"),
      Buffer.from("password-b", "utf8"),
      SIGNUP_TOKEN!,
    );
    createdUserIds.push(userIdA, userIdB);

    expect(Buffer.from(dataKeyA).equals(Buffer.from(dataKeyB))).toBe(false);
    expect(Buffer.from(dataKeyA).equals(Buffer.from(getDevUserDataKey(userIdA)))).toBe(false);
    expect(Buffer.from(dataKeyB).equals(Buffer.from(getDevUserDataKey(userIdB)))).toBe(false);
  });

  it("rejects a duplicate email", async () => {
    const email = freshEmail("dup");
    const { userId } = await createUser(email, Buffer.from("pw1", "utf8"), SIGNUP_TOKEN!);
    createdUserIds.push(userId);

    await expect(
      createUser(email, Buffer.from("pw2", "utf8"), SIGNUP_TOKEN!),
    ).rejects.toBeInstanceOf(EmailAlreadyExistsError);
  });

  it("rejects a wrong signup token", async () => {
    await expect(
      createUser(freshEmail("bad-token"), Buffer.from("pw", "utf8"), "definitely-wrong"),
    ).rejects.toBeInstanceOf(InvalidSignupTokenError);
  });

  it("rejects when MONI_SIGNUP_TOKEN is unset (fails closed, never open)", async () => {
    const original = process.env.MONI_SIGNUP_TOKEN;
    delete process.env.MONI_SIGNUP_TOKEN;
    try {
      await expect(
        createUser(freshEmail("no-token"), Buffer.from("pw", "utf8"), ""),
      ).rejects.toBeInstanceOf(InvalidSignupTokenError);
    } finally {
      process.env.MONI_SIGNUP_TOKEN = original;
    }
  });

  it("user_unlock_methods: cross-tenant isolation", async () => {
    const { userId: userIdA } = await createUser(
      freshEmail("iso-a"),
      Buffer.from("pw-a", "utf8"),
      SIGNUP_TOKEN!,
    );
    const { userId: userIdB } = await createUser(
      freshEmail("iso-b"),
      Buffer.from("pw-b", "utf8"),
      SIGNUP_TOKEN!,
    );
    createdUserIds.push(userIdA, userIdB);

    await withUser(userIdA, async (tx) => {
      const rows = await tx.select().from(schema.userUnlockMethods);
      expect(rows.map((r) => r.ownerId)).toEqual([userIdA]);
    });

    await withUser(userIdB, async (tx) => {
      const rows = await tx.select().from(schema.userUnlockMethods);
      expect(rows.map((r) => r.ownerId)).toEqual([userIdB]);
    });

    // An explicit cross-owner filter, scoped as A, still yields zero rows
    // (RLS filters silently — domain-layer.md §5 item 1/4's shape).
    await withUser(userIdA, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.userUnlockMethods)
        .where(eq(schema.userUnlockMethods.ownerId, userIdB));
      expect(rows).toEqual([]);
    });
  });
});
