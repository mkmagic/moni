// The challenge half of arming the credential window with a passkey.
//
// 409 rather than 401 when there is nothing to assert with: the caller is
// authenticated and the request is well-formed — the account simply has no
// second factor enrolled yet, and the remediation is "enrol a passkey", not
// "log in again".
import { NextRequest, NextResponse } from "next/server";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";
import { getSessionFromRequest } from "@/domain/auth";
import { listCredentialUnlockMethods } from "@/domain/credential-unlock";
import { putPendingCeremony } from "@/lib/auth/webauthn-challenge";
import { rpId } from "@/lib/auth/webauthn-config";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const methods = await listCredentialUnlockMethods(session.userId);
  if (methods.length === 0) {
    return NextResponse.json({ error: "no_passkey_enrolled" }, { status: 409 });
  }

  const rp = rpId();
  const usable = methods.filter((m) => m.ref.rpId === rp);
  if (usable.length === 0) {
    // A WebAuthn binding has no re-scope API, so say plainly what happened
    // instead of failing as a generic auth error. Re-enrolling means
    // re-entering the bank logins — the user needs to know that, not guess.
    const enrolledUnder = [...new Set(methods.map((m) => m.ref.rpId))].join(", ");
    return NextResponse.json(
      {
        error:
          `Your passkey was registered for ${enrolledUnder}, but this deployment is ` +
          `${rp}. Enrol a new passkey and re-enter your bank logins.`,
      },
      { status: 409 },
    );
  }

  const authenticationOptions = await generateAuthenticationOptions({
    rpID: rp,
    allowCredentials: usable.map((m) => ({
      id: m.ref.credentialIdB64Url,
      transports: m.ref.transports as AuthenticatorTransportFuture[] | undefined,
    })),
    // Enforced again on verify — a client claim is not a fact.
    userVerification: "required",
  });

  putPendingCeremony(session.id, { kind: "arm", challenge: authenticationOptions.challenge });

  return NextResponse.json({ authenticationOptions });
}
