import Link from "next/link";
import { requireSession } from "@/domain/auth";
import { getProfile } from "@/domain/profile";
import { listConnections } from "@/domain/connections";
import { getLatestSyncRunByConnection } from "@/domain/sync-promotion";
import { Button } from "@/components/ui/button";
import { SyncPreference } from "../sync-preference";
import { ConnectionsList } from "../connections-list";

export default async function ConnectionsSettingsPage() {
  const session = await requireSession();
  const [profile, connections, latestRuns] = await Promise.all([
    getProfile(session.userId),
    listConnections(session.userId),
    getLatestSyncRunByConnection(session.userId),
  ]);

  // Dates cross the boundary already FORMATTED, not as ISO strings for the
  // client to render. Formatting there with `toLocaleString()` is a
  // hydration bug: SSR uses the server's locale/timezone and the browser
  // uses its own, React sees two different strings and throws. Doing it
  // once here — explicit locale, so it's deterministic — also keeps the
  // client component free of date logic. "medium" is spelled-out month, so
  // it's unambiguous rather than dd/mm-vs-mm/dd.
  const syncedAtFmt = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const rows = connections.map((c) => {
    const run = latestRuns[c.id];
    return {
      id: c.id,
      connectorId: c.connectorId,
      displayName: c.displayName,
      status: c.status,
      lastSyncLabel: c.lastSyncAt
        ? `Last synced ${syncedAtFmt.format(c.lastSyncAt)}`
        : "Never synced",
      // Surfaced so a failure survives a page reload — the client's own
      // error state doesn't.
      lastRunFailed: run?.status === "failed",
      lastRunError: run?.status === "failed" ? (run.error ?? null) : null,
    };
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">Linked bank and credit card logins</p>
        <Link href="/settings/connections/connect">
          <Button>Add connection</Button>
        </Link>
      </div>
      <SyncPreference initial={profile?.autoSyncOnLogin ?? false} />
      <ConnectionsList initialConnections={rows} />
    </div>
  );
}
