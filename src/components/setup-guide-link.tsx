import { CircleHelp } from "lucide-react";

/** "How do I get these?" under a connector's login fields. Opens in a new tab so
 * a half-filled form survives the trip to the broker's site and back. */
export function SetupGuideLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="-mt-2 inline-flex items-center gap-1.5 self-start text-xs text-primary underline-offset-2 hover:underline"
    >
      <CircleHelp className="h-3.5 w-3.5" />
      How do I get these?
    </a>
  );
}
