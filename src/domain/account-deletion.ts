// Account deletion (issue #31) — the only operation in the app that removes
// a user's data permanently, and the only one with no undo.
//
// TWO INDEPENDENT GUARDS KEEP THIS FROM TOUCHING ANOTHER USER'S ROWS, and
// both are deliberate rather than redundant:
//
//   1. Every statement runs inside `withUser()`, so FORCE ROW LEVEL SECURITY
//      already restricts it to `owner_id = current_setting('app.user_id')`.
//      If `app.user_id` were somehow unset, the policies evaluate against
//      NULL and the DELETEs match ZERO rows — fail closed, not fail open
//      (drizzle/0001_rls_and_roles.sql §6).
//   2. Every statement ALSO carries an explicit owner predicate. On its own
//      that would violate the "never rely on a WHERE user_id = ? alone"
//      invariant (CLAUDE.md), but as a second layer it means a bug in either
//      guard alone still cannot widen the blast radius.
//
// The statements are spelled out one per table, in child-before-parent order,
// rather than looped over a table list. A loop would read as one line but
// hide the ordering that makes it correct, and this is the last function in
// the codebase that should be clever. tests/db/account-deletion.test.ts
// asserts the coverage is complete by reading the table list out of
// `information_schema` — so a new owner-scoped table that nobody adds here
// fails the suite instead of silently orphaning rows.
//
// NOT handled here, on purpose: a scrape running in the background
// (scripts/scrape-worker.mts) whose writes land after the delete. Its inserts
// fail the foreign key back to `users` and the child process dies with an
// error nobody is left to read, which is the correct outcome — there is no
// scheduler to cancel and inventing a cancellation protocol for it is out of
// scope for #31. Note the residual: until that child exits it still holds the
// decrypted bank credentials it was scraping with in its OWN process memory,
// which `endAllSessionsForUser()` cannot reach — it only wipes the web
// process's RAM maps. Bounded by the scrape's own lifetime, and the fix is a
// real job queue with cancellation, not something to bolt on here.
import { eq } from "drizzle-orm";
import { withUser } from "@/db/client";
import {
  accountBalanceSnapshots,
  accounts,
  categories,
  budgetCeilings,
  budgetIncomes,
  categoryRejections,
  connections,
  creditCardDetails,
  entries,
  entryFieldChangelog,
  entryTransactions,
  instrumentSourceMappings,
  instruments,
  investmentMarketQuotes,
  investmentSnapshotCashBalances,
  investmentSnapshotDetails,
  investmentSnapshotPositions,
  investmentSourceEvidence,
  merchantLookups,
  merchants,
  ruleActions,
  ruleConditions,
  longTermSavingsDetails,
  longTermSavingsSnapshotDeposits,
  longTermSavingsSnapshotTracks,
  longTermSavingsSnapshots,
  rules,
  syncRuns,
  syncStaging,
  transfers,
  users,
  userUnlockMethods,
} from "@/db/schema";
import { endAllSessionsForUser, verifyPassword } from "@/domain/auth";

export type DeleteAccountResult = "deleted" | "invalid-password";

/**
 * Deletes `userId` and everything they own. The row removal is one atomic
 * transaction; the password check ahead of it is a separate one, so a caller
 * should read this as "verified, then deleted" rather than as a single unit.
 * Nothing between the two can change the answer — only the account's own
 * owner could re-key their password, and they are the caller.
 *
 * The password check lives inside this function rather than at the route, so
 * there is no way to reach the deletion without it — a live session cookie is
 * not sufficient authority to destroy an account. `password` is a Tier-0
 * `Buffer` owned by the caller (the route wipes it).
 *
 * Returns `"invalid-password"` and changes nothing if the password does not
 * verify. That is also the answer for an already-deleted user: their unlock
 * method row is gone, so there is nothing left to verify against.
 */
export async function deleteAccount(
  userId: string,
  password: Buffer,
): Promise<DeleteAccountResult> {
  if (!(await verifyPassword(userId, password))) return "invalid-password";

  await withUser(userId, async (tx) => {
    // Leaves — nothing references these.
    await tx.delete(investmentMarketQuotes).where(eq(investmentMarketQuotes.ownerId, userId));
    await tx
      .delete(investmentSnapshotCashBalances)
      .where(eq(investmentSnapshotCashBalances.ownerId, userId));
    await tx
      .delete(investmentSnapshotPositions)
      .where(eq(investmentSnapshotPositions.ownerId, userId));
    await tx.delete(investmentSourceEvidence).where(eq(investmentSourceEvidence.ownerId, userId));
    await tx.delete(investmentSnapshotDetails).where(eq(investmentSnapshotDetails.ownerId, userId));
    await tx.delete(instrumentSourceMappings).where(eq(instrumentSourceMappings.ownerId, userId));
    await tx.delete(instruments).where(eq(instruments.ownerId, userId));
    await tx.delete(budgetCeilings).where(eq(budgetCeilings.ownerId, userId));
    await tx.delete(budgetIncomes).where(eq(budgetIncomes.ownerId, userId));
    await tx.delete(categoryRejections).where(eq(categoryRejections.ownerId, userId));
    await tx.delete(merchantLookups).where(eq(merchantLookups.ownerId, userId));
    await tx.delete(entryFieldChangelog).where(eq(entryFieldChangelog.ownerId, userId));
    await tx.delete(entryTransactions).where(eq(entryTransactions.ownerId, userId));
    await tx.delete(syncStaging).where(eq(syncStaging.ownerId, userId));
    await tx.delete(transfers).where(eq(transfers.ownerId, userId));
    await tx
      .delete(longTermSavingsSnapshotDeposits)
      .where(eq(longTermSavingsSnapshotDeposits.ownerId, userId));
    await tx
      .delete(longTermSavingsSnapshotTracks)
      .where(eq(longTermSavingsSnapshotTracks.ownerId, userId));
    // Named explicitly rather than left to the cascades from
    // `account_balance_snapshots`, so this list stays the single readable
    // answer to "what does deleting a user remove".
    await tx.delete(longTermSavingsSnapshots).where(eq(longTermSavingsSnapshots.ownerId, userId));

    // `entries` — now unreferenced by the five above.
    await tx.delete(entries).where(eq(entries.ownerId, userId));

    // Rules: conditions self-reference by `parent_id`, but a single DELETE
    // over the whole set is fine — Postgres fires referential-integrity
    // triggers at end of statement, not per row.
    await tx.delete(ruleConditions).where(eq(ruleConditions.ownerId, userId));
    await tx.delete(ruleActions).where(eq(ruleActions.ownerId, userId));
    await tx.delete(rules).where(eq(rules.ownerId, userId));

    // Accounts and their subtype/history tables.
    await tx.delete(creditCardDetails).where(eq(creditCardDetails.ownerId, userId));
    await tx.delete(longTermSavingsDetails).where(eq(longTermSavingsDetails.ownerId, userId));
    await tx.delete(accountBalanceSnapshots).where(eq(accountBalanceSnapshots.ownerId, userId));
    await tx.delete(accounts).where(eq(accounts.ownerId, userId));

    // Connections, now unreferenced by accounts and sync runs. This is what
    // takes the encrypted bank credentials with it.
    await tx.delete(syncRuns).where(eq(syncRuns.ownerId, userId));
    await tx.delete(connections).where(eq(connections.ownerId, userId));

    // Classification roots — `categories` also self-references by `parent_id`.
    await tx.delete(merchants).where(eq(merchants.ownerId, userId));
    await tx.delete(categories).where(eq(categories.ownerId, userId));

    // Key custody, then the identity row itself.
    await tx.delete(userUnlockMethods).where(eq(userUnlockMethods.ownerId, userId));
    await tx.delete(users).where(eq(users.id, userId));
  });

  // Only after the rows are gone: any still-live session for this user holds
  // an unwrapped data key in RAM that now decrypts nothing.
  endAllSessionsForUser(userId);

  return "deleted";
}
