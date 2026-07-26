import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireSession } from "@/domain/auth";
import { Card } from "@/components/ui/card";
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
          Link another bank or credit card. Your credentials are encrypted before they&apos;re
          stored.
        </p>
      </div>
      <Card>
        <div className="p-6">
          <ConnectWizard />
        </div>
      </Card>
    </div>
  );
}
