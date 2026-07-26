// In-memory credential-key window — the second, tighter RAM window
// (docs/security/threat-model.md §5.3, the plan's §B "Two RAM windows"). A
// separate module from session-store.ts on purpose: "am I logged in"
// (identity + the data key) is a different capability from "may I use
// stored bank credentials right now" (the credential key), and the two must
// stay decoupled — a stolen session cookie alone must never yield a bank
// credential.
//
// The credential window also needs a materially tighter sweep than the
// session store's: reusing the session store's 10-minute sweep against this
// window's 10-minute TTL would let an abandoned window sit un-swept for
// ~100% of its own lifetime (vs. ~2% for the 8h session against its 10-
// minute sweep). 60 seconds here instead.
//
// Keyed by sessionId, so at most one credential window exists per session,
// and logout (src/domain/auth.ts's endSession) cascades to wipe it via one
// lookup.
import { wipe } from "@/lib/crypto";

interface CredentialWindow {
  sessionId: string;
  userId: string;
  /** Unwrapped per-user credential key — Tier-0, RAM-only, wiped on destroy/expiry. */
  credentialKey: Buffer;
  /** Epoch ms after which the window is dead and its key must be wiped. */
  expiresAt: number;
}

/** Bounded arm window: a password re-entry unlocks bank credentials for at most this long. */
const TTL_MS = 10 * 60 * 1000; // 10 minutes

// Survive Next.js dev HMR (module re-evaluation) so an edit doesn't strand a
// live window with an un-wiped key. Single Map per server process.
const globalStore = globalThis as unknown as { __moniCredWindows?: Map<string, CredentialWindow> };
const store: Map<string, CredentialWindow> = (globalStore.__moniCredWindows ??= new Map());

/**
 * Arms the credential window for `sessionId`, wiping any prior window's key
 * first (a re-arm always destroys-then-creates, never leaves two live keys).
 */
export function armCredentialWindow(
  sessionId: string,
  userId: string,
  credentialKey: Buffer,
): void {
  destroyCredentialWindow(sessionId);
  store.set(sessionId, { sessionId, userId, credentialKey, expiresAt: Date.now() + TTL_MS });
}

/** Returns the live credential key for `sessionId`, or null if missing/expired
 * (expired keys are wiped). */
export function getCredentialKey(sessionId: string): Buffer | null {
  const w = store.get(sessionId);
  if (!w) return null;
  if (Date.now() > w.expiresAt) {
    destroyCredentialWindow(sessionId);
    return null;
  }
  return w.credentialKey;
}

/** Destroys the credential window for `sessionId` and wipes its key from memory. */
export function destroyCredentialWindow(sessionId: string): void {
  const w = store.get(sessionId);
  if (!w) return;
  wipe(w.credentialKey);
  store.delete(sessionId);
}

// Periodic sweep, tighter than session-store.ts's — see the file header for
// why. `.unref()` keeps this from holding the process open.
const globalSweeper = globalThis as unknown as { __moniCredSweeper?: NodeJS.Timeout };
if (!globalSweeper.__moniCredSweeper) {
  globalSweeper.__moniCredSweeper = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, w] of store) {
      if (now > w.expiresAt) destroyCredentialWindow(sessionId);
    }
  }, 60 * 1000);
  globalSweeper.__moniCredSweeper.unref?.();
}
