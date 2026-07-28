"use client";

import { useRouter } from "next/navigation";
import { ConnectFlow } from "@/components/connect-flow";

/** The same flow onboarding runs, reused rather than reinvented, for adding a
 * second (or later) connection from Settings. It syncs the new connection
 * immediately — that's what gives the backfill window somewhere to go, and it
 * fixes a connection otherwise sitting unsynced until the user noticed the
 * button. */
export function ConnectWizard({ today }: { today: string }) {
  const router = useRouter();

  function done() {
    router.push("/settings/connections");
    router.refresh();
  }

  return <ConnectFlow today={today} doneLabel="Done" onDone={done} />;
}
