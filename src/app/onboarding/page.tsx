import { redirect } from "next/navigation";
import { Wallet } from "lucide-react";
import { requireSession } from "@/domain/auth";
import { listConnections } from "@/domain/connections";
import { OnboardingWizard } from "./onboarding-wizard";

// Deliberately NOT under src/app/(app)/ despite the plan's file listing:
// (app)/layout.tsx redirects any zero-connections user to /onboarding, and
// nesting this page under that same layout would make it redirect to
// itself. Top-level (same tier as /login and /signup) avoids the loop with
// no extra machinery — this route needs no sidebar anyway.
export default async function OnboardingPage() {
  const session = await requireSession();
  const connections = await listConnections(session.userId);
  if (connections.length > 0) redirect("/dashboard");

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-lg">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-[var(--radius)] bg-primary/15 text-primary">
            <Wallet size={20} strokeWidth={2.25} />
          </span>
          <div>
            <p className="text-lg font-semibold leading-tight">Moni</p>
            <p className="text-xs text-muted-foreground">Let&apos;s connect your first account.</p>
          </div>
        </div>
        <OnboardingWizard />
      </div>
    </main>
  );
}
