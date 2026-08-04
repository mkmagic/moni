import { redirect } from "next/navigation";
import { requireSession } from "@/domain/auth";
import { listConnections } from "@/domain/connections";
import { listCredentialUnlockMethods } from "@/domain/credential-unlock";
import { todayIso } from "@/lib/backfill-window";
import { OnboardingWizard } from "./onboarding-wizard";

// Deliberately NOT under src/app/(app)/ despite the plan's file listing:
// (app)/layout.tsx redirects any zero-connections user to /onboarding, and
// nesting this page under that same layout would make it redirect to
// itself. Top-level (same tier as /login and /signup) avoids the loop with
// no extra machinery — this route needs no sidebar anyway.
export default async function OnboardingPage() {
  const session = await requireSession();
  const [connections, unlockMethods] = await Promise.all([
    listConnections(session.userId),
    listCredentialUnlockMethods(session.userId),
  ]);
  if (connections.length > 0) redirect("/dashboard");

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-lg">
        <div className="mb-6 flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element -- next/image's optimizer proxies through a mocked internal request with no Host header, which src/proxy.ts's HTTPS-only gate rejects */}
          <img src="/moni-icon.png" alt="" className="h-11 w-auto" />
          <div>
            <p className="text-lg font-semibold leading-tight">Moni</p>
            <p className="text-xs text-muted-foreground">Let&apos;s connect your first account.</p>
          </div>
        </div>
        {/* Today's date is computed HERE, on the server, and passed down: the
            backfill picker's bounds must agree with the cap the sync route
            enforces, and deriving them in the browser would depend on the
            visitor's clock. */}
        <OnboardingWizard today={todayIso()} hasPasskey={unlockMethods.length > 0} />
      </div>
    </main>
  );
}
