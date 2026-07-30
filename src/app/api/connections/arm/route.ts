// Arm the ~10-minute credential window with an enrolled passkey (issue #7,
// replacing the Moni-password re-entry this route used to accept).
//
// The password is gone from this path on purpose, not for convenience. A
// typed secret can be captured by a phishing page and replayed forever; a
// PRF output is origin-bound and non-replayable, so the harvesting target
// simply stops existing. That property is the whole reason WebAuthn-PRF was
// chosen over a second password (which would have satisfied #18's letter).
//
// The server verifies the assertion signature and the user-verification flag
// itself, so "a biometric/PIN actually happened" is a verified fact rather
// than a client claim — that is what makes the passkey a factor rather than
// a secret sitting on an unlocked machine.
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import { getSessionFromRequest } from "@/domain/auth";
import {
  listCredentialUnlockMethods,
  recordAssertionCounter,
  unlockCredentialKey,
} from "@/domain/credential-unlock";
import { armCredentialWindow } from "@/lib/auth/cred-window";
import { takePendingCeremony } from "@/lib/auth/webauthn-challenge";
import { relyingParty } from "@/lib/auth/webauthn-config";
import { AssertionResponseSchema, PrfSecretSchema } from "@/lib/auth/webauthn-schemas";
import { wipe } from "@/lib/crypto";

// Zod at the trust boundary (docs/design/conventions.md — Validation).
const ArmSchema = z.object({
  assertionResponse: AssertionResponseSchema,
  prfSecret: PrfSecretSchema,
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Single-use, taken up front: a failed attempt never gets a second go at
  // the same challenge.
  const pending = takePendingCeremony(session.id, "arm");
  if (!pending) {
    return NextResponse.json({ error: "unlock expired — try again" }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const parsed = ArmSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  const { rpId, origin } = relyingParty();
  const methods = await listCredentialUnlockMethods(session.userId);
  const method = methods.find((m) => m.ref.credentialIdB64Url === parsed.data.assertionResponse.id);
  if (!method || method.ref.rpId !== rpId) {
    return NextResponse.json({ error: "unknown passkey" }, { status: 401 });
  }

  const assertion = await verifyAuthenticationResponse({
    response: parsed.data.assertionResponse as AuthenticationResponseJSON,
    expectedChallenge: pending.challenge,
    expectedOrigin: origin,
    expectedRPID: rpId,
    credential: {
      id: method.ref.credentialIdB64Url,
      publicKey: new Uint8Array(Buffer.from(method.ref.publicKeyB64Url, "base64url")),
      counter: method.ref.counter,
      transports: method.ref.transports as AuthenticatorTransportFuture[] | undefined,
    },
    requireUserVerification: true,
  }).catch(() => null);

  if (!assertion?.verified || !assertion.authenticationInfo.userVerified) {
    return NextResponse.json({ error: "passkey verification failed" }, { status: 401 });
  }

  await recordAssertionCounter(session.userId, method.id, assertion.authenticationInfo.newCounter);

  const unlockSecret = Buffer.from(parsed.data.prfSecret, "base64url");
  try {
    const credentialKey = await unlockCredentialKey(session.userId, method.id, unlockSecret);
    if (!credentialKey) {
      // The assertion verified but its PRF output doesn't open CK — a
      // provider that changed what it evaluates, or a client that sent a
      // different salt's output. Either way there is nothing to arm.
      return NextResponse.json({ error: "passkey could not unlock" }, { status: 401 });
    }
    // Ownership of credentialKey transfers to the window store here —
    // nothing left for this route to wipe.
    armCredentialWindow(session.id, session.userId, credentialKey);
    return NextResponse.json({ ok: true });
  } finally {
    wipe(unlockSecret);
  }
}
