// Zod shapes for the WebAuthn payloads that cross the trust boundary
// (docs/design/conventions.md — Validation), shared by the passkey routes.
//
// These pin the *structure* only. The actual security check is
// SimpleWebAuthn's `verifyRegistrationResponse`/`verifyAuthenticationResponse`,
// which is built to be handed hostile input — re-implementing CBOR and
// signature validation in Zod would be both futile and worse. What these
// schemas buy is that a malformed body becomes a 400 instead of an exception
// deep inside the verifier.
import { z } from "zod";
import { UNLOCK_SECRET_LENGTH } from "@/lib/auth/unlock-secret";

const b64url = z.string().min(1).max(4096);

export const RegistrationResponseSchema = z.object({
  id: b64url,
  rawId: b64url,
  type: z.literal("public-key"),
  authenticatorAttachment: z.string().optional(),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  response: z.object({
    clientDataJSON: b64url,
    attestationObject: z.string().min(1),
    transports: z.array(z.string()).optional(),
    publicKeyAlgorithm: z.number().optional(),
    publicKey: z.string().optional(),
    authenticatorData: z.string().optional(),
  }),
});

export const AssertionResponseSchema = z.object({
  id: b64url,
  rawId: b64url,
  type: z.literal("public-key"),
  authenticatorAttachment: z.string().optional(),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  response: z.object({
    clientDataJSON: b64url,
    authenticatorData: b64url,
    signature: b64url,
    userHandle: z.string().optional(),
  }),
});

/**
 * The PRF output, base64url. Length is checked after decoding because
 * `Buffer.from(s, "base64url")` silently drops invalid characters rather
 * than throwing — a truncated secret must be a 400, never a KEK derived
 * from whatever survived the decode.
 */
export const PrfSecretSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((s) => Buffer.from(s, "base64url").length === UNLOCK_SECRET_LENGTH, {
    message: `must decode to ${UNLOCK_SECRET_LENGTH} bytes`,
  });
