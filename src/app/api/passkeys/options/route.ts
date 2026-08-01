// Issues BOTH challenges an enrollment needs, in one round trip (issue #7).
//
// Enrolling a passkey is two ceremonies back to back: `create` proves the
// provider can do PRF and yields a public key, then `get` produces the PRF
// output that actually wraps CK. Only after both verify does a
// `user_unlock_methods` row exist — see src/domain/credential-unlock.ts for
// why the create ceremony's own PRF output is never trusted.
import { NextRequest, NextResponse } from "next/server";
import { generateAuthenticationOptions, generateRegistrationOptions } from "@simplewebauthn/server";
import { getSessionFromRequest } from "@/domain/auth";
import { listCredentialUnlockMethods } from "@/domain/credential-unlock";
import { getProfile } from "@/domain/profile";
import { getCredentialKey } from "@/lib/auth/cred-window";
import { putPendingCeremony } from "@/lib/auth/webauthn-challenge";
import { RP_NAME, rpId } from "@/lib/auth/webauthn-config";
import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const profile = await getProfile(session.userId);
  if (!profile) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const existing = await listCredentialUnlockMethods(session.userId);

  // An additional passkey has to wrap the CK the armed window is holding, so
  // refuse before issuing challenges rather than after: POST /api/passkeys
  // consumes them single-use, and a 423 there would strand the user with two
  // spent biometric prompts and nothing to retry with.
  if (existing.length > 0 && !getCredentialKey(session.id)) {
    return NextResponse.json({ error: "credential_window_locked" }, { status: 423 });
  }

  const rp = rpId();

  const registrationOptions = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rp,
    userName: profile.email,
    userDisplayName: profile.displayName ?? profile.email,
    // A stable per-user handle, so re-enrolling on the same provider
    // replaces rather than accumulates entries in the user's passkey list.
    userID: Buffer.from(session.userId.replace(/-/g, ""), "hex"),
    // No attestation and no device-bound requirement: it can't be reliably
    // enforced from the web API anyway, and a lost device would otherwise
    // destroy bank credentials outright (there is no recovery path for CK).
    attestationType: "none",
    excludeCredentials: existing.map((m) => ({
      id: m.ref.credentialIdB64Url,
      transports: m.ref.transports as AuthenticatorTransportFuture[] | undefined,
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      // The biometric/PIN prompt is the point — this passkey is a factor,
      // not a secret sitting on an unlocked machine. Enforced again
      // server-side on every verify.
      userVerification: "required",
    },
  });

  const activationOptions = await generateAuthenticationOptions({
    rpID: rp,
    userVerification: "required",
  });

  putPendingCeremony(session.id, {
    kind: "enroll",
    registrationChallenge: registrationOptions.challenge,
    activationChallenge: activationOptions.challenge,
  });

  return NextResponse.json({ registrationOptions, activationOptions });
}
