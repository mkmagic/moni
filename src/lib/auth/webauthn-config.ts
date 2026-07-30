// WebAuthn relying-party configuration, from explicit env vars (issue #7).
//
// The RP ID is NOT derived from the request's `Host` header. A `Host` is
// attacker-influenceable, and worse, it silently rebinds the first time Moni
// moves behind a different proxy — which is the worst possible failure mode
// for a binding that has no re-scope API and cannot be migrated. A passkey
// enrolled under the wrong RP ID is a passkey that can never open the bank
// credentials it wrapped, and there is no recovery path for CK.
//
// Validation throws rather than falling back to a default, because the
// failure a default would cause is silent and permanent: enrollments minted
// under a guessed RP ID look fine and can never be opened again.
//
// It happens on first USE, not at module load, and memoizes from there.
// `next build` collects page data by importing every route module in an
// environment that legitimately has no runtime env, so a load-time throw
// fails the build rather than the misconfiguration. Deferring by one tick
// keeps the loud failure exactly where it matters — the first passkey
// request — without making a build depend on deployment config.

/** Shown in the platform's passkey UI. */
export const RP_NAME = "Moni";

interface RelyingParty {
  rpId: string;
  origin: string;
}

let cached: RelyingParty | undefined;

/** The validated `{ rpId, origin }` pair. Throws if either var is missing or
 * the two disagree. */
export function relyingParty(): RelyingParty {
  if (!cached) {
    const rpId = requireRpId();
    cached = { rpId, origin: requireOrigin(rpId) };
  }
  return cached;
}

/** The relying-party id — a registrable domain, e.g. `moni.example.com`. */
export function rpId(): string {
  return relyingParty().rpId;
}

/** Full origin the browser will report, e.g. `https://moni.example.com`. */
export function rpOrigin(): string {
  return relyingParty().origin;
}

function requireRpId(): string {
  const value = process.env.MONI_WEBAUTHN_RP_ID?.trim();
  if (!value) {
    throw new Error(
      "MONI_WEBAUTHN_RP_ID is not set. Passkey enrollment binds irreversibly " +
        "to this value — it must be stated explicitly, never guessed from a " +
        "request header. See .env.example.",
    );
  }
  // A bare registrable domain: no scheme, no port, no path. Getting this
  // wrong produces a `SecurityError` in the browser with no hint of why.
  if (/[:/]/.test(value)) {
    throw new Error(
      `MONI_WEBAUTHN_RP_ID must be a bare domain with no scheme, port or path (got "${value}").`,
    );
  }
  return value;
}

function requireOrigin(expectedRpId: string): string {
  const value = process.env.MONI_WEBAUTHN_ORIGIN?.trim();
  if (!value) {
    throw new Error("MONI_WEBAUTHN_ORIGIN is not set (see .env.example).");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`MONI_WEBAUTHN_ORIGIN must be an absolute origin URL (got "${value}").`);
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new Error(
      `MONI_WEBAUTHN_ORIGIN must be https (got "${value}"); only localhost may be http.`,
    );
  }
  // The browser enforces this pairing anyway; catching it here turns an
  // opaque client-side SecurityError into a message that names the two vars
  // that disagree.
  if (url.hostname !== expectedRpId && !url.hostname.endsWith(`.${expectedRpId}`)) {
    throw new Error(
      `MONI_WEBAUTHN_ORIGIN ("${url.hostname}") is not ${expectedRpId} or a subdomain of it — ` +
        "the browser will reject every ceremony until these agree.",
    );
  }
  return url.origin;
}
