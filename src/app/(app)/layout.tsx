import { requireSession } from "@/domain/auth";
import { Sidebar } from "@/components/sidebar";
import { TourProvider } from "@/components/tour/tour-provider";

// The zero-connections -> /onboarding redirect deliberately does NOT live
// here any more. It used to, but /settings now holds Profile, and bouncing a
// zero-connection user out of it would lock them out of their own name and
// preferences until they'd linked a bank. A layout can't reliably know its
// own pathname in the App Router, so rather than sniff an internal header,
// each page that genuinely requires a connection calls `requireOnboarded()`
// (src/domain/onboarding.ts) for itself.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();

  return (
    // Column on mobile so the sidebar's top bar stacks above the content; the
    // fixed rail returns as the left column at `md` and up.
    <TourProvider>
      <div className="flex min-h-screen flex-col md:flex-row">
        <Sidebar baseCurrency={session.baseCurrency} />
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-6xl px-6 py-8 md:px-8">{children}</div>
        </main>
      </div>
    </TourProvider>
  );
}
