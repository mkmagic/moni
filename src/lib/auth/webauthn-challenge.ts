// Pending WebAuthn ceremonies, in RAM, keyed by session id.
//
// A WebAuthn challenge is only meaningful if the server issued it, has not
// seen it before, and is still waiting for it — so it has to be stored
// somewhere between the `/options` call and the response that answers it.
// RAM, per session, single-use: the same custody posture as the session and
// credential-key windows, and for the same reason (nothing about an unlock
// ceremony belongs on disk).
//
// Nothing here is a secret — a challenge is a public nonce, and a pending
// enrollment holds a credential id and a public key. It is `expiresAt` and
// single-use consumption that carry the weight, not confidentiality.

/** A ceremony the user has three minutes to complete before it's dead. */
const TTL_MS = 3 * 60 * 1000;

/**
 * Enrollment is two ceremonies: `create` proves the authenticator supports
 * PRF and gives us a public key, then `get` produces the PRF output that
 * actually wraps CK. Both challenges are issued together so the browser can
 * run them back to back, and the row is only written once both have been
 * verified (src/domain/credential-unlock.ts explains why the `get` output is
 * the only one trusted).
 */
export interface PendingEnrollment {
  kind: "enroll";
  registrationChallenge: string;
  activationChallenge: string;
}

/** Arming an existing passkey — one `get` ceremony. */
export interface PendingArm {
  kind: "arm";
  challenge: string;
}

export type Ceremony = PendingEnrollment | PendingArm;

type Pending = Ceremony & { expiresAt: number };

// Survive Next.js dev HMR (module re-evaluation), like cred-window.ts.
const globalStore = globalThis as unknown as { __moniWebauthnPending?: Map<string, Pending> };
const store: Map<string, Pending> = (globalStore.__moniWebauthnPending ??= new Map());

/** Stores a ceremony for `sessionId`, replacing any ceremony already pending
 * (starting a new one always abandons the old — never two live at once). */
export function putPendingCeremony(sessionId: string, ceremony: Ceremony): void {
  store.set(sessionId, { ...ceremony, expiresAt: Date.now() + TTL_MS });
}

/**
 * Returns the pending ceremony of the expected kind and REMOVES it — a
 * challenge answers exactly one response. Returns null if absent, expired,
 * or of the wrong kind (answering an arm challenge with an enrollment, or
 * vice versa, is not a thing that should be allowed to work).
 */
export function takePendingCeremony<K extends Ceremony["kind"]>(
  sessionId: string,
  kind: K,
): Extract<Ceremony, { kind: K }> | null {
  const pending = store.get(sessionId);
  if (!pending) return null;
  store.delete(sessionId);
  if (pending.kind !== kind || Date.now() > pending.expiresAt) return null;
  return pending as unknown as Extract<Ceremony, { kind: K }>;
}

/** Drops any pending ceremony for `sessionId` (logout). */
export function clearPendingCeremony(sessionId: string): void {
  store.delete(sessionId);
}

// Periodic sweep at the TTL's granularity — an abandoned ceremony is inert,
// but the map should not grow without bound. `.unref()` keeps this from
// holding the process open (same pattern as cred-window.ts).
const globalSweeper = globalThis as unknown as { __moniWebauthnSweeper?: NodeJS.Timeout };
if (!globalSweeper.__moniWebauthnSweeper) {
  globalSweeper.__moniWebauthnSweeper = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, pending] of store) {
      if (now > pending.expiresAt) store.delete(sessionId);
    }
  }, TTL_MS);
  globalSweeper.__moniWebauthnSweeper.unref?.();
}
