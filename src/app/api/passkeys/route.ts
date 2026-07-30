// POST completes a passkey enrollment. (There is no GET: the settings page
// lists passkeys server-side through the domain layer.)
//
// POST is the only place a `webauthn-prf` unlock method is ever written. It
// insists on both halves of the ceremony pair issued by
// /api/passkeys/options — the registration, and an assertion made with the
// passkey that registration just created — because the assertion's PRF
// output is the only one that can be trusted to be reproducible later
// (src/domain/credential-unlock.ts explains why).
//
// Enrolling an ADDITIONAL passkey requires an already-armed credential
// window: the new passkey must wrap the SAME CK, and there is no other way
// for the server to hold it.
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { getSessionFromRequest } from "@/domain/auth";
import {
  CredentialKeyRequiredError,
  PasskeyAlreadyEnrolledError,
  enrollCredentialUnlockMethod,
  listCredentialUnlockMethods,
} from "@/domain/credential-unlock";
import { armCredentialWindow, getCredentialKey } from "@/lib/auth/cred-window";
import { takePendingCeremony } from "@/lib/auth/webauthn-challenge";
import { relyingParty } from "@/lib/auth/webauthn-config";
import {
  AssertionResponseSchema,
  PrfSecretSchema,
  RegistrationResponseSchema,
} from "@/lib/auth/webauthn-schemas";
import { wipe } from "@/lib/crypto";

const EnrollSchema = z.object({
  label: z.string().min(1).max(60).default("Passkey"),
  registrationResponse: RegistrationResponseSchema,
  assertionResponse: AssertionResponseSchema,
  prfSecret: PrfSecretSchema,
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Single-use: taken here whether or not the rest succeeds, so a failed
  // attempt can never be retried against the same challenge.
  const pending = takePendingCeremony(session.id, "enroll");
  if (!pending) {
    return NextResponse.json({ error: "enrollment expired — start again" }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const parsed = EnrollSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  const { rpId, origin } = relyingParty();

  const registration = await verifyRegistrationResponse({
    response: parsed.data.registrationResponse as RegistrationResponseJSON,
    expectedChallenge: pending.registrationChallenge,
    expectedOrigin: origin,
    expectedRPID: rpId,
    requireUserVerification: true,
  }).catch(() => null);

  if (!registration?.verified) {
    return NextResponse.json(
      { error: "passkey registration failed verification" },
      { status: 400 },
    );
  }
  const credential = registration.registrationInfo.credential;

  // The assertion must come from the passkey we just registered — not from
  // some other passkey the authenticator happened to offer.
  if (parsed.data.assertionResponse.id !== credential.id) {
    return NextResponse.json({ error: "passkey verification failed" }, { status: 400 });
  }

  const assertion = await verifyAuthenticationResponse({
    response: parsed.data.assertionResponse as AuthenticationResponseJSON,
    expectedChallenge: pending.activationChallenge,
    expectedOrigin: origin,
    expectedRPID: rpId,
    credential,
    requireUserVerification: true,
  }).catch(() => null);

  if (!assertion?.verified || !assertion.authenticationInfo.userVerified) {
    return NextResponse.json({ error: "passkey verification failed" }, { status: 400 });
  }

  // Additional passkeys wrap the CK already in the armed window. The first
  // one mints it, and needs nothing.
  const existing = await listCredentialUnlockMethods(session.userId);
  const armedCredentialKey = existing.length > 0 ? getCredentialKey(session.id) : null;
  if (existing.length > 0 && !armedCredentialKey) {
    return NextResponse.json({ error: "credential_window_locked" }, { status: 423 });
  }

  const unlockSecret = Buffer.from(parsed.data.prfSecret, "base64url");
  try {
    const { methodId, credentialKey } = await enrollCredentialUnlockMethod(
      session.userId,
      unlockSecret,
      {
        credentialIdB64Url: credential.id,
        publicKeyB64Url: Buffer.from(credential.publicKey).toString("base64url"),
        counter: assertion.authenticationInfo.newCounter,
        transports: credential.transports as AuthenticatorTransportFuture[] | undefined,
        rpId,
        label: parsed.data.label,
      },
      armedCredentialKey,
    );

    // Ownership of credentialKey transfers to the window store here — the
    // route must not wipe it past this point. Enrollment leaves the window
    // armed so "add a passkey, then connect a bank" needs no second prompt.
    armCredentialWindow(session.id, session.userId, credentialKey);
    return NextResponse.json({ id: methodId, label: parsed.data.label }, { status: 201 });
  } catch (err) {
    if (err instanceof PasskeyAlreadyEnrolledError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof CredentialKeyRequiredError) {
      return NextResponse.json({ error: "credential_window_locked" }, { status: 423 });
    }
    throw err;
  } finally {
    wipe(unlockSecret);
  }
}
