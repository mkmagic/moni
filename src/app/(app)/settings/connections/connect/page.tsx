import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireSession } from "@/domain/auth";
import { Card } from "@/components/ui/card";
import { todayIso } from "@/lib/backfill-window";
import { ConnectWizard } from "./connect-wizard";

export default async function ConnectPage() {
  await requireSession();

  return (
    <div className="flex max-w-lg flex-col gap-5">
      <div>
        <Link
          href="/settings/connections"
          className="mb-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground transition hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to connections
        </Link>
        <h2 className="text-lg font-semibold text-foreground">Add a connection</h2>
        <p className="text-sm text-muted-foreground">
          Link a bank, card, brokerage or long-term savings provider. Login credentials are
          encrypted before storage; file-import connections store no credentials and keep no copy of
          what you upload.
        </p>
      </div>
      <Card>
        <div className="p-6">
          {/* Server-computed so the picker's bounds match the cap the sync
              route enforces — see the same note in /onboarding. */}
          <ConnectWizard today={todayIso()} />
        </div>
      </Card>
    </div>
  );
}
