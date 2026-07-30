// Sign-up — the one function that mints a new user's key custody
// (docs/security/threat-model.md §5, the plan's §A2 "Registration"). A
// genuinely random data key (DK, Tier-1 reads) is wrapped under an
// Argon2id(password) KEK and stored on a single `user_unlock_methods` row,
// bound to *that row's* id — never `users.id` — per the AAD row-binding rule
// (docs/design/encryption.md §3, src/lib/crypto/aad.ts).
//
// The credential key (CK, Tier-0 bank-credential reads) is deliberately NOT
// minted here (issue #7). The login password must be structurally incapable
// of reaching CK, so CK comes into existence only when the user enrolls a
// passkey — see src/domain/credential-unlock.ts. Until then the account
// simply cannot hold a bank credential, which is the correct state rather
// than a gap.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { withUser } from "@/db/client";
import { users, userUnlockMethods } from "@/db/schema";
import { deriveKekFromPassword, wrapWithKek, DEFAULT_ARGON2_PARAMS } from "@/lib/auth/password";
import { wipe, type AadContext } from "@/lib/crypto";
import { seedDefaultCategories } from "./categorization";

/** Thrown when the email is already registered. Detected via the DB's
 * unique constraint, never a pre-SELECT — RLS makes "does this email exist?"
 * unanswerable before login, by design (data-model.md §2). */
export class EmailAlreadyExistsError extends Error {
  constructor(email: string) {
    super(`An account with email ${email} already exists`);
    this.name = "EmailAlreadyExistsError";
  }
}

/** Thrown when the caller's signup token doesn't match `MONI_SIGNUP_TOKEN`.
 * An unset/empty env var counts as a mismatch — fail closed, never open
 * (threat-model.md §1: accounts are owner-issued, not self-served). */
export class InvalidSignupTokenError extends Error {
  constructor() {
    super("Invalid signup token");
    this.name = "InvalidSignupTokenError";
  }
}

/** Constant-time string comparison. Both inputs are first hashed to a fixed
 * 32-byte digest so `timingSafeEqual` (which requires equal-length buffers)
 * never rejects on length alone before it can compare content. */
function timingSafeStringEqual(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a, "utf8").digest();
  const digestB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(digestA, digestB);
}

/** The `users.email` unique-constraint violation, surfaced through
 * drizzle-orm's `DrizzleQueryError` wrapper (the real Postgres error lives
 * at `.cause`, not on the error itself — see tests/db/composite-fk.test.ts
 * for the same pattern). */
function isEmailUniqueViolation(err: unknown): boolean {
  const cause = (err as { cause?: { code?: unknown; constraint?: unknown } } | undefined)?.cause;
  return cause?.code === "23505" && cause?.constraint === "users_email_unique";
}

/**
 * Creates a new user with real, random key custody and returns
 * `{ userId, dataKey }`. `dataKey` is NOT wiped here — it is returned to the
 * caller (typically straight into `createSession()` for auto-login); the
 * session store owns its lifetime from there. `password` is owned by the
 * caller and not wiped here either, matching the login-route convention
 * (src/app/api/auth/login/route.ts wipes its own copy).
 *
 * Gated by `MONI_SIGNUP_TOKEN`, the owner-shared invite token that stands in
 * for real invite links in v1.0 (vision.md; threat-model.md §1 assumes
 * accounts are handed out by the owner, not self-served on the open
 * internet).
 */
export async function createUser(
  email: string,
  password: Buffer,
  signupToken: string,
): Promise<{ userId: string; dataKey: Buffer }> {
  const expectedToken = process.env.MONI_SIGNUP_TOKEN;
  if (!expectedToken || !timingSafeStringEqual(signupToken, expectedToken)) {
    throw new InvalidSignupTokenError();
  }

  // AAD binds to these ids, so both must exist before any encryption
  // (seed-demo.ts's `const checkingId = randomUUID()` pattern, never
  // `defaultRandom()` for a row with ciphertext).
  const userId = randomUUID();
  const methodId = randomUUID();
  const dataKey = randomBytes(32); // REAL random — never the dev key provider.
  const salt = randomBytes(16);

  const kek = await deriveKekFromPassword(password, salt);
  try {
    const dataKeyAad: AadContext = { rowId: methodId, column: "wrapped_data_key", version: 1 };
    const wrappedDataKey = wrapWithKek(kek, dataKeyAad, dataKey);

    try {
      await withUser(userId, async (tx) => {
        await tx.insert(users).values({ id: userId, email, baseCurrency: "ILS" });
        await tx.insert(userUnlockMethods).values({
          id: methodId,
          ownerId: userId,
          type: "password-argon2id",
          wrappedDataKey,
          // NOT a placeholder — the password method must never wrap CK
          // (issue #7 / #18). Only a passkey row carries a CK wrap.
          wrappedCredentialKey: null,
          unlockRef: { saltB64: salt.toString("base64"), params: DEFAULT_ARGON2_PARAMS },
        });
        // The shipped category tree. Plaintext Tier-2 labels, so this needs
        // no data key and can land in the same transaction as the user.
        await seedDefaultCategories(tx, userId);
      });
    } catch (err) {
      if (isEmailUniqueViolation(err)) throw new EmailAlreadyExistsError(email);
      throw err;
    }

    return { userId, dataKey };
  } finally {
    wipe(kek);
  }
}
