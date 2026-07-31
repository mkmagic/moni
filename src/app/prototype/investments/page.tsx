import { Sidebar } from "@/components/sidebar";
import { InvestmentsPrototype } from "./prototype";
import type { PrototypeVariant } from "@/components/prototype-switcher";

// Three Investments-screen variants, switchable via ?variant=, on
// /prototype/investments. PROTOTYPE ONLY — mock data, no persistence.
export default async function InvestmentsPrototypePage({
  searchParams,
}: {
  searchParams: Promise<{ variant?: string }>;
}) {
  const requested = (await searchParams).variant?.toUpperCase();
  const variant: PrototypeVariant = requested === "B" || requested === "C" ? requested : "A";
  return (
    <div className="flex min-h-screen">
      <Sidebar baseCurrency="ILS" />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-6 py-8 md:px-8">
          <InvestmentsPrototype variant={variant} />
        </div>
      </main>
    </div>
  );
}
