// The browser half of the passkey ceremonies (issue #7). Everything that
// knows what WebAuthn *is* lives here and in src/app/api/passkeys/**; the
// domain layer only ever sees 32 opaque bytes.
//
// Two flows:
//   * `enrollPasskey` — register a passkey, then immediately assert with it,
//     and only send the server the PRF output from the ASSERTION. The create
//     ceremony is used solely to prove the provider supports PRF. Platforms
//     have been observed returning a different PRF output on create than on
//     get (Apple forums 764730), and a wrap only the create ceremony can
//     open is a wrap nobody can ever open — there is no recovery for CK.
//   * `armWithPasskey` — one assertion, whose PRF output unwraps CK for the
//     ~10-minute credential window.
//
// The PRF output leaves the browser as base64url over TLS. It has to: the
// scraper (`israeli-bank-scrapers`) runs server-side under Node, so CK must
// reach the server no matter what. Client-side unwrapping is impossible
// here, not merely undesirable.
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";

/**
 * PRF evaluation salt for the credential key. Fixed and purpose-scoped: a
 * future agent-side secret (#22/#23) on the same passkey evaluates a
 * DIFFERENT salt, so the two are unrelated by construction rather than by
 * discipline. Different passkeys produce different outputs from this one
 * salt, which is why it needs no per-credential randomness. Not a secret.
 */
const CREDENTIAL_KEY_PRF_SALT = new TextEncoder().encode("moni:credential-key:v1");

/** The `prf` extension predates the DOM lib types SimpleWebAuthn ships, so
 * its input/output shapes are declared narrowly here rather than cast to
 * `any` at each use. */
interface PrfExtensionOutputs {
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer | Uint8Array } };
}

export type PasskeyResult<T> =
  | { ok: true; value: T }
  /** `message` is safe to show the user verbatim. */
  | { ok: false; message: string };

const PRF_UNSUPPORTED_MESSAGE =
  "This password manager can't provide the key Moni needs to protect your bank logins. " +
  "Choose your device's built-in option (iCloud Keychain, Google Password Manager, " +
  "Windows Hello) or a security key instead.";

/** True when the browser can do WebAuthn at all. */
export function browserSupportsPasskeys(): boolean {
  return typeof window !== "undefined" && !!window.PublicKeyCredential;
}

/** Adds the PRF request to server-issued options. The salt must be real
 * bytes, not base64url — SimpleWebAuthn passes `extensions` through to
 * `navigator.credentials.*` untouched. */
function withPrf<T extends { extensions?: unknown }>(options: T, evaluate: boolean): T {
  return {
    ...options,
    extensions: {
      ...(options.extensions as object | undefined),
      prf: evaluate ? { eval: { first: CREDENTIAL_KEY_PRF_SALT } } : {},
    },
  };
}

function prfOutputs(results: unknown): PrfExtensionOutputs["prf"] {
  return (results as PrfExtensionOutputs | undefined)?.prf;
}

/** Extracts the 32-byte PRF output as base64url, or null if absent. */
function prfSecretB64Url(results: unknown): string | null {
  const first = prfOutputs(results)?.results?.first;
  if (!first) return null;
  const bytes = first instanceof Uint8Array ? first : new Uint8Array(first);
  if (bytes.length !== 32) return null;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The PRF output is Tier-0. Strip it from the payload posted alongside the
 * assertion — it travels in its own field, and duplicating it (as an
 * unserializable ArrayBuffer, no less) only muddies what is sensitive. */
function withoutPrf<T extends { clientExtensionResults: object }>(response: T): T {
  const results: PrfExtensionOutputs = { ...response.clientExtensionResults };
  delete results.prf;
  return { ...response, clientExtensionResults: results };
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? fallback;
}

export interface EnrolledPasskey {
  id: string;
  label: string;
}

/**
 * Registers a passkey and enrolls it against CK. On success the credential
 * window is armed, so the caller can go straight on to connecting a bank.
 */
export async function enrollPasskey(label: string): Promise<PasskeyResult<EnrolledPasskey>> {
  if (!browserSupportsPasskeys()) {
    return { ok: false, message: "This browser doesn't support passkeys." };
  }

  // Adding a passkey to an existing set needs the credential window open —
  // the new one has to wrap the same CK. So the options call can 423: arm
  // with a passkey already enrolled, then ask again. A first-ever enrollment
  // never takes that branch, and pays one prompt pair instead of two.
  const options = await sendUnlocked(() => postJson("/api/passkeys/options", {}));
  if (!options.ok) return { ok: false, message: options.message };
  const optionsRes = options.res;
  if (!optionsRes.ok) {
    return { ok: false, message: await errorMessage(optionsRes, "Could not start enrollment") };
  }
  const { registrationOptions, activationOptions } = (await optionsRes.json()) as {
    registrationOptions: PublicKeyCredentialCreationOptionsJSON;
    activationOptions: PublicKeyCredentialRequestOptionsJSON;
  };

  let registrationResponse: RegistrationResponseJSON;
  try {
    registrationResponse = await startRegistration({
      optionsJSON: withPrf(registrationOptions, false),
    });
  } catch (err) {
    return { ok: false, message: ceremonyMessage(err, "Passkey setup was cancelled.") };
  }

  // The gate the decision calls for: a browser will happily default to
  // whichever extension is installed, and Bitwarden (as of July 2026) drops
  // the PRF extension results entirely. Refuse here rather than leave a
  // family member holding a passkey that silently cannot unlock anything.
  if (prfOutputs(registrationResponse.clientExtensionResults)?.enabled !== true) {
    return { ok: false, message: PRF_UNSUPPORTED_MESSAGE };
  }

  // Assert immediately with the passkey just created — this, not the create
  // ceremony, is where the PRF output that wraps CK comes from.
  let assertionResponse: AuthenticationResponseJSON;
  try {
    assertionResponse = await startAuthentication({
      optionsJSON: withPrf(
        {
          ...activationOptions,
          allowCredentials: [{ id: registrationResponse.id, type: "public-key" as const }],
        },
        true,
      ),
    });
  } catch (err) {
    return { ok: false, message: ceremonyMessage(err, "Confirming the new passkey failed.") };
  }

  const prfSecret = prfSecretB64Url(assertionResponse.clientExtensionResults);
  if (!prfSecret) return { ok: false, message: PRF_UNSUPPORTED_MESSAGE };

  const res = await postJson("/api/passkeys", {
    label,
    registrationResponse: withoutPrf(registrationResponse),
    assertionResponse: withoutPrf(assertionResponse),
    prfSecret,
  });
  if (!res.ok) {
    // The window can still lapse between the options call and this one; say
    // so in words, because `credential_window_locked` is what the raw body
    // would otherwise put on screen.
    if (res.status === 423) {
      return { ok: false, message: "The unlock window closed before the passkey was saved." };
    }
    return { ok: false, message: await errorMessage(res, "Could not save the passkey") };
  }
  return { ok: true, value: (await res.json()) as EnrolledPasskey };
}

/**
 * Opens the credential window with an enrolled passkey — the replacement for
 * the old "re-enter your Moni password" prompt. Returns `ok: false` with a
 * showable message on cancellation, an unenrolled device, or an RP ID
 * mismatch after the deployment moved.
 */
export async function armWithPasskey(): Promise<PasskeyResult<null>> {
  if (!browserSupportsPasskeys()) {
    return { ok: false, message: "This browser doesn't support passkeys." };
  }

  const optionsRes = await postJson("/api/connections/arm/options", {});
  if (!optionsRes.ok) {
    const message = await errorMessage(optionsRes, "Could not start unlocking");
    // The server's machine-readable "nothing enrolled" — turn it into the
    // sentence that actually tells the user what to do, here at the edge
    // rather than shipping a status code to the screen.
    return {
      ok: false,
      message:
        message === "no_passkey_enrolled"
          ? "Set up a passkey first — Settings › Connections. It's what unlocks your stored bank logins."
          : message,
    };
  }
  const { authenticationOptions } = (await optionsRes.json()) as {
    authenticationOptions: PublicKeyCredentialRequestOptionsJSON;
  };

  let assertionResponse: AuthenticationResponseJSON;
  try {
    assertionResponse = await startAuthentication({
      optionsJSON: withPrf(authenticationOptions, true),
    });
  } catch (err) {
    return { ok: false, message: ceremonyMessage(err, "Unlocking was cancelled.") };
  }

  const prfSecret = prfSecretB64Url(assertionResponse.clientExtensionResults);
  if (!prfSecret) return { ok: false, message: PRF_UNSUPPORTED_MESSAGE };

  const res = await postJson("/api/connections/arm", {
    assertionResponse: withoutPrf(assertionResponse),
    prfSecret,
  });
  if (!res.ok) return { ok: false, message: await errorMessage(res, "Could not unlock") };
  return { ok: true, value: null };
}

/**
 * Sends a request that needs CK, arming with a passkey and retrying exactly
 * once if the credential window turns out to be closed.
 *
 * Every write that touches bank credentials now hits this shape — creating a
 * connection, replacing its login — and each one has the same right answer
 * to a 423: unlock, then send the same body again. Once, deliberately: a
 * second 423 after a successful arm means something other than an expired
 * window, and retrying forever would just re-prompt for a biometric.
 */
export async function sendUnlocked(
  send: () => Promise<Response>,
): Promise<{ ok: true; res: Response } | { ok: false; message: string }> {
  const first = await send();
  if (first.status !== 423) return { ok: true, res: first };

  const armed = await armWithPasskey();
  if (!armed.ok) return { ok: false, message: armed.message };
  return { ok: true, res: await send() };
}

/** A cancelled ceremony (`NotAllowedError`) is the common case and not an
 * error worth shouting about; anything else keeps its own message, which is
 * usually the only clue to a misconfigured RP ID. */
function ceremonyMessage(err: unknown, cancelled: string): string {
  const name = (err as { name?: string } | undefined)?.name;
  if (name === "NotAllowedError" || name === "AbortError") return cancelled;
  const message = (err as { message?: string } | undefined)?.message;
  return message || cancelled;
}
