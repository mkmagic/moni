import { Card } from "@/components/ui/card";
import { ReplayTourButton } from "@/components/tour/replay-tour-button";

/** Settings › Help — the home for the replayable product tour. Kept as its own
 * tab (rather than a corner of Profile) so "where do I see the tour again?" has
 * an obvious answer, which is exactly what the first-run prompt points at when
 * a user declines it. */
export default function HelpSettingsPage() {
  return (
    <div className="flex max-w-xl flex-col gap-6">
      <Card className="flex flex-col gap-4 p-6">
        <div className="flex flex-col gap-1.5">
          <h2 className="text-base font-semibold text-foreground">Guided tour</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            A quick, visual walk through the dashboard, each section of the app, and where to
            configure things like AI. Replay it whenever you want a refresher on where to find
            something.
          </p>
        </div>
        <ReplayTourButton />
      </Card>
    </div>
  );
}
