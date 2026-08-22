// Domain layer for the user's own identity + preference columns on `users`.
// Everything here is plaintext by design — a display name and a sync
// preference carry no financial information, so they are not Tier-1 encrypted
// fields (see the column comments in src/db/schema/identity.ts). Key custody
// lives on `user_unlock_methods` and is never touched from here.
import { eq } from "drizzle-orm";
import { withUser } from "@/db/client";
import { users } from "@/db/schema";

export interface UserProfile {
  email: string;
  displayName: string | null;
  baseCurrency: string;
  autoSyncOnLogin: boolean;
  smartCategorize: boolean;
  agentAccessEnabled: boolean;
}

export interface ProfileUpdate {
  /** Trimmed; an empty string clears the name back to null. */
  displayName?: string | null;
  autoSyncOnLogin?: boolean;
  smartCategorize?: boolean;
  /** Master opt-in for agent (MCP) access. Off disables every existing token
   * for this user at once (issue #113 Phase 5). */
  agentAccessEnabled?: boolean;
}

/** Reads the caller's own profile. RLS scopes this to their row. */
export async function getProfile(userId: string): Promise<UserProfile | null> {
  return withUser(userId, async (tx) => {
    const rows = await tx
      .select({
        email: users.email,
        displayName: users.displayName,
        baseCurrency: users.baseCurrency,
        autoSyncOnLogin: users.autoSyncOnLogin,
        smartCategorize: users.smartCategorize,
        agentAccessEnabled: users.agentAccessEnabled,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return rows[0] ?? null;
  });
}

/**
 * Updates the caller's own profile. Only the fields present in `update` are
 * written, so a preference toggle can't blank a name it never sent.
 *
 * `users` carries no ciphertext columns, so unlike every other update in the
 * domain layer this one deliberately does NOT bump a row `version` — there is
 * nothing bound to it by AAD. (Contrast `connections`, where changing
 * `credentials_ct` must bump the version; docs plan §E.2.)
 */
export async function updateProfile(userId: string, update: ProfileUpdate): Promise<void> {
  const patch: {
    displayName?: string | null;
    autoSyncOnLogin?: boolean;
    smartCategorize?: boolean;
    agentAccessEnabled?: boolean;
  } = {};
  if (update.displayName !== undefined) {
    const trimmed = update.displayName?.trim() ?? "";
    patch.displayName = trimmed === "" ? null : trimmed;
  }
  if (update.autoSyncOnLogin !== undefined) patch.autoSyncOnLogin = update.autoSyncOnLogin;
  if (update.smartCategorize !== undefined) patch.smartCategorize = update.smartCategorize;
  if (update.agentAccessEnabled !== undefined) patch.agentAccessEnabled = update.agentAccessEnabled;
  if (Object.keys(patch).length === 0) return;

  await withUser(userId, async (tx) => {
    await tx.update(users).set(patch).where(eq(users.id, userId));
  });
}
