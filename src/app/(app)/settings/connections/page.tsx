import Link from "next/link";
import { requireSession } from "@/domain/auth";
import { getProfile } from "@/domain/profile";
import { listConnections } from "@/domain/connections";
import { listCredentialUnlockMethods } from "@/domain/credential-unlock";
import { getLatestSyncRunByConnection } from "@/domain/sync-promotion";
import { rpId } from "@/lib/auth/webauthn-config";
import { Button } from "@/components/ui/button";
import { PasskeyManager } from "@/components/passkey-manager";
import { SyncPreference } from "../sync-preference";
import { ConnectionsList } from "../connections-list";

export default async function ConnectionsSettingsPage() {
  const session = await requireSession();
  const [profile, connections, latestRuns, passkeys] = await Promise.all([
    getProfile(session.userId),
    listConnections(session.userId),
    getLatestSyncRunByConnection(session.userId),
    listCredentialUnlockMethods(session.userId),
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
  // Import connections have no fetch time — their `lastSyncAt` is the date the
  // uploaded file is *as of* (see domain/connections.ts), a calendar date with
  // no meaningful clock time, so it reads "As of 30 Jun 2026" with no "00:00".
  const asOfFmt = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });
  const rows = connections.map((c) => {
    const run = latestRuns[c.id];
    const isImport = c.mode === "user_mediated_import";
    return {
      id: c.id,
      connectorId: c.connectorId,
      displayName: c.displayName,
      status: c.status,
      mode: c.mode,
      lastSyncLabel: c.lastSyncAt
        ? isImport
          ? `As of ${asOfFmt.format(c.lastSyncAt)}`
          : `Last synced ${syncedAtFmt.format(c.lastSyncAt)}`
        : isImport
          ? "No file uploaded"
          : "Never synced",
      // Surfaced so a failure survives a page reload — the client's own
      // error state doesn't.
      lastRunFailed: run?.status === "failed",
      lastRunError: run?.status === "failed" ? (run.error ?? null) : null,
    };
  });

  // Same reason as `syncedAtFmt` above: formatted here, on the server.
  const addedAtFmt = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });
  const passkeyRows = passkeys.map((p) => ({
    id: p.id,
    label: p.ref.label,
    addedLabel: `Added ${addedAtFmt.format(p.createdAt)}`,
    usable: p.ref.rpId === rpId(),
    rpId: p.ref.rpId,
  }));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">Linked banks, cards, and brokerages</p>
        <Link href="/settings/connections/connect">
          <Button variant="outline">Add connection</Button>
        </Link>
      </div>
      {/* Above the connections themselves: with no passkey there is no key to
          encrypt a bank login under, so this is the prerequisite, not a
          footnote. It also owns this view's amber when nothing is enrolled. */}
      <PasskeyManager initialPasskeys={passkeyRows} />
      <SyncPreference initial={profile?.autoSyncOnLogin ?? false} />
      <ConnectionsList initialConnections={rows} />
    </div>
  );
}
