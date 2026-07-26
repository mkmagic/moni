import { redirect } from "next/navigation";
import { listConnections } from "./connections";

/**
 * Sends a user with no connections to /onboarding. Call at the top of any
 * page whose content is meaningless without one (dashboard, accounts,
 * transactions) — NOT from the shared (app) layout, because /settings must
 * stay reachable so a new user can set their name and preferences before
 * linking a bank.
 *
 * Connection count IS the "onboarding complete" signal; there is no separate
 * column (docs plan §A3). /onboarding lives outside the (app) layout so this
 * redirect can never loop back on itself.
 */
export async function requireOnboarded(userId: string): Promise<void> {
  const connections = await listConnections(userId);
  if (connections.length === 0) redirect("/onboarding");
}
