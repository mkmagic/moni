import { requireSession } from "@/domain/auth";
import { Card } from "@/components/ui/card";

// Placeholder for Wave 6b. The queue, opening-lots card, and resolution flows
// land here next; for now the route resolves so the sub-navigation works.
export default async function InvestmentActivityPage() {
  await requireSession();
  return (
    <Card className="flex min-h-[240px] flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="text-sm font-medium text-foreground">Activity & lots</p>
      <p className="max-w-md text-sm text-muted-foreground">
        Pending investment items and your opening-lot history will live here. Coming next.
      </p>
    </Card>
  );
}
