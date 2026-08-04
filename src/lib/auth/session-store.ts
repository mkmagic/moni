// In-memory session store — the bounded, RAM-only unlock window.
//
// After login unwraps a user's data key (password.ts), the key lives ONLY
// here, in process memory, keyed by an opaque session id (the cookie value).
// It is never written to disk, swap, or logs, and is `fill(0)`-wiped on
// logout or TTL expiry (docs/security/security-design-principles.md §7,
// docs/security/threat-model.md §5.3/§5.5). A process restart drops all
// sessions — acceptable for the self-hosted, single-process model (the vision
// explicitly rules out horizontal scale).
import { randomBytes } from "node:crypto";
import { wipe } from "@/lib/crypto";

export interface Session {
  id: string;
  userId: string;
  /** Unwrapped per-user data key — Tier-0, RAM-only, wiped on destroy/expiry. */
  dataKey: Buffer;
  baseCurrency: string;
  /**
   * Set at login when the user opted into `autoSyncOnLogin` AND the gap since
   * their previous login exceeded the threshold. Purely a UI hint — it grants
   * nothing. Acting on it still goes through the normal 423 -> arm -> sync
   * path, so no credential key is unwrapped at login and the two RAM windows
   * stay decoupled (docs plan §B). Cleared once the user answers.
   */
  promptSyncOnLogin: boolean;
  /** Epoch ms after which the session is dead and its key must be wiped. */
  expiresAt: number;
}

/**
 * Bounded unlock window: one login lasts at most this long.
 *
 * **The single origin of the session lifetime.** Everything that has to agree
 * with it derives from here rather than restating the number — the cookie's
 * `maxAge` (via `SESSION_TTL_SECONDS` below) and the sync-reminder gap in
 * src/domain/auth.ts. Change it here and every dependent window follows.
 */
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

/**
 * The same window in seconds, for the session cookie's `maxAge`. Derived
 * rather than written out again at the routes, so the cookie can never
 * outlive the RAM session it points at — a longer cookie just means the
 * browser keeps presenting an id this store has already dropped.
 */
export const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;

// Survive Next.js dev HMR (module re-evaluation) so an edit doesn't strand
// live sessions with un-wiped keys. Single Map per server process.
const globalStore = globalThis as unknown as { __moniSessions?: Map<string, Session> };
const store: Map<string, Session> = (globalStore.__moniSessions ??= new Map());

/** Creates a session holding `dataKey`; returns the opaque 128-bit session id. */
export function createSession(
  userId: string,
  dataKey: Buffer,
  baseCurrency: string,
  promptSyncOnLogin = false,
): string {
  const id = randomBytes(16).toString("hex");
  store.set(id, {
    id,
    userId,
    dataKey,
    baseCurrency,
    promptSyncOnLogin,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return id;
}

/** Clears the login sync prompt once the user has accepted or dismissed it,
 * so it doesn't reappear on every navigation for the rest of the session. */
export function dismissSyncPrompt(id: string): void {
  const s = store.get(id);
  if (s) s.promptSyncOnLogin = false;
}

/** Returns the live session for `id`, or null if missing/expired (expired keys are wiped). */
export function getSession(id: string | undefined): Session | null {
  if (!id) return null;
  const s = store.get(id);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    destroySession(id);
    return null;
  }
  return s;
}

/** Every live session id belonging to `userId` — one per device/browser the
 * user logged in from. Used by account deletion, which has to reach the
 * sessions it is not itself being called through. */
export function sessionIdsForUser(userId: string): string[] {
  return [...store.values()].filter((s) => s.userId === userId).map((s) => s.id);
}

/** Destroys a session and wipes its data key from memory. */
export function destroySession(id: string): void {
  const s = store.get(id);
  if (!s) return;
  wipe(s.dataKey);
  store.delete(id);
}

// Periodic sweep so an abandoned session's key doesn't linger past its TTL
// waiting for a getSession() call. `.unref()` keeps this from holding the
// process open.
const globalSweeper = globalThis as unknown as { __moniSweeper?: NodeJS.Timeout };
if (!globalSweeper.__moniSweeper) {
  globalSweeper.__moniSweeper = setInterval(
    () => {
      const now = Date.now();
      for (const [id, s] of store) {
        if (now > s.expiresAt) destroySession(id);
      }
    },
    10 * 60 * 1000,
  );
  globalSweeper.__moniSweeper.unref?.();
}
