import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft, TriangleAlert } from "lucide-react";
import { Card } from "@/components/ui/card";
import { AiSetupPrompt } from "./ai-setup-prompt";

/** The one-time Client Portal setup a new user needs before the IBKR Flex
 * connection can sync. Reached only from that connector's login fields
 * ("How do I get these?") — it means nothing to anyone without an IBKR
 * account, so it has no entry in Settings › Help. IBKR offers no way to import
 * a query template or create one through an API, so the guide is the feature.
 * Screenshots were taken from a real Client Portal (account details masked)
 * and live in public/help/ibkr/. Section and field names here are IBKR's exact
 * labels — keep them, and the AI prompt, in step with what ibkr-flex.ts reads. */
export default function IbkrSetupGuidePage() {
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div>
        <Link
          href="/settings/connections"
          className="mb-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground transition hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to connections
        </Link>
        <h2 className="text-lg font-semibold text-foreground">Connect Interactive Brokers</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Moni reads your Interactive Brokers account through a <em>Flex Query</em> — a saved report
          you build once in IBKR&apos;s Client Portal. It takes about ten minutes, and you come back
          with two things to paste into Moni: a <strong>Flex token</strong> and a{" "}
          <strong>Query ID</strong>.
        </p>
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-primary underline-offset-2 hover:underline">
            Watch the whole walkthrough
          </summary>
          <Shot
            src="/help/ibkr/ibkr-flex-setup.gif"
            alt="Animated walkthrough of every step below"
            width={900}
            height={433}
          />
        </details>
      </div>

      <AiSetupPrompt />

      <Step n={1} title="Turn on the Flex Web Service and create a token">
        <p>
          Log in to Client Portal and open <Path>Performance &amp; Reports → Flex Queries</Path>.
          Click the gear next to <Path>Flex Web Service Configuration</Path>.
        </p>
        <Shot
          src="/help/ibkr/01-flex-queries.webp"
          alt="The Flex Queries page, with the token gear, the new-query plus and the info icon marked"
        />
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Tick <Path>Flex Web Service Status</Path>, then click <Path>Generate New Token</Path>.
          </li>
          <li>Pick the longest expiry on offer, so you aren&apos;t back here every few weeks.</li>
          <li>Leave the IP address empty — Moni&apos;s server address can change.</li>
          <li>Copy the token. This is your Flex token.</li>
        </ul>
        <Shot src="/help/ibkr/02-token.webp" alt="The Configure Flex Web Service page" />
        <Note>
          Generating a new token replaces the old one at once. If another app already uses a Flex
          token from this account, reuse that token instead of generating a new one.
        </Note>
      </Step>

      <Step n={2} title="Create the Activity Flex Query">
        <p>
          Back on <Path>Flex Queries</Path>, click the <Path>+</Path> next to{" "}
          <Path>Activity Flex Query</Path> and give it a name, such as &ldquo;Moni&rdquo;.
        </p>
        <Shot src="/help/ibkr/03-create.webp" alt="The Create Activity Flex Query form" />
        <p>
          Click each section below to open it, set its options, then click <Path>Save</Path> at the
          bottom of that window. <Path>Select All</Path> is the first row of every field list.
        </p>
        <Shot
          src="/help/ibkr/04-sections.webp"
          alt="The section list with the sections Moni needs marked"
        />
        <SectionTable
          caption="Required — Moni can't value your account without these"
          rows={[
            [
              "Account Information",
              "Tick only Account ID and Currency. Moni doesn't need your address or date of birth.",
            ],
            ["Open Positions", "Tick both Summary and Lot, then Select All."],
            ["Cash Report", "Tick Currency Breakout, then Select All."],
            ["Net Asset Value (NAV) in Base", "Select All."],
          ]}
        />
        <SectionTable
          caption="Recommended — your trade history, dividends and returns"
          rows={[
            ["Trades", "Execution is already ticked; Select All."],
            ["Cash Transactions", "Select All."],
            ["Change in Dividend Accruals", "Select All."],
            ["Corporate Actions", "Select All."],
          ]}
        />
        <Shot
          src="/help/ibkr/05-open-positions.webp"
          alt="Open Positions with Summary, Lot and Select All ticked"
        />
        <Shot
          src="/help/ibkr/06-cash-report.webp"
          alt="Cash Report with Currency Breakout and Select All ticked"
        />
        <Shot
          src="/help/ibkr/07-trades.webp"
          alt="Trades with Execution ticked and Select All marked"
        />
        <p>
          Scroll down to <Path>Delivery Configuration</Path>. Keep <Path>Format</Path> on XML and
          change <Path>Period</Path> to <Path>Last 365 Calendar Days</Path>.
        </p>
        <Shot
          src="/help/ibkr/08-delivery.webp"
          alt="Delivery Configuration with Format and Period marked"
        />
        <p>
          Leave everything under <Path>General Configuration</Path> as it is —{" "}
          <Path>Breakout by Day</Path> in particular must stay on No. Click <Path>Continue</Path>,
          then confirm on the summary screen.
        </p>
        <Shot src="/help/ibkr/09-general.webp" alt="General Configuration left at its defaults" />
        <Shot src="/help/ibkr/10-continue.webp" alt="The Continue button" />
      </Step>

      <Step n={3} title="Find the Query ID">
        <p>
          On <Path>Flex Queries</Path>, click the <Path>i</Path> icon next to your new query. The
          number next to <Path>Query ID</Path> is what Moni needs.
        </p>
        <Shot
          src="/help/ibkr/11-query-id.webp"
          alt="The query details window showing the Query ID"
          width={960}
          height={262}
        />
      </Step>

      <Step n={4} title="Paste both into Moni">
        <p>
          Go to{" "}
          <Link
            href="/settings/connections/connect"
            className="font-medium text-primary hover:underline"
          >
            Add a connection
          </Link>
          , choose <Path>Interactive Brokers Flex</Path>, and paste the Flex token and Query ID. The
          first sync starts straight away.
        </p>
      </Step>

      <Card className="flex flex-col gap-3 p-6 text-sm leading-relaxed text-muted-foreground">
        <h3 className="text-base font-semibold text-foreground">If a sync fails</h3>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <span className="text-foreground">Token expired or invalid</span> — generate a new token
            (step 1), then use <Path>Replace login details</Path> on the connection in Settings ›
            Connections.
          </li>
          <li>
            <span className="text-foreground">A section is missing</span> — the error names it.
            Click the pencil next to your query in IBKR, add that section as in step 2, and sync
            again. The Query ID stays the same.
          </li>
          <li>
            <span className="text-foreground">IP address refused</span> — the token was limited to
            one IP address. Generate a new one with the IP field left empty.
          </li>
        </ul>
      </Card>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <Card className="flex flex-col gap-4 p-6 text-sm leading-relaxed text-muted-foreground">
      <h3 className="flex items-center gap-3 text-base font-semibold text-foreground">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-primary/60 font-mono text-xs text-primary">
          {n}
        </span>
        {title}
      </h3>
      {children}
    </Card>
  );
}

/** An IBKR screen label, set apart so it reads as "look for this on screen". */
function Path({ children }: { children: ReactNode }) {
  return <span className="font-medium text-foreground">{children}</span>;
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="flex gap-2 rounded-[var(--radius)] border border-primary/40 p-3 text-xs">
      <TriangleAlert className="h-4 w-4 shrink-0 text-primary" />
      <span>{children}</span>
    </p>
  );
}

/** A screenshot that opens full size in a new tab — the labels are small. */
function Shot({
  src,
  alt,
  width = 1200,
  height = 577,
}: {
  src: string;
  alt: string;
  width?: number;
  height?: number;
}) {
  return (
    <a href={src} target="_blank" rel="noreferrer" className="mt-2 block">
      <Image
        src={src}
        alt={alt}
        width={width}
        height={height}
        unoptimized
        className="h-auto w-full rounded-[var(--radius)] border border-border"
      />
    </a>
  );
}

function SectionTable({ caption, rows }: { caption: string; rows: [string, string][] }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {caption}
      </span>
      <div className="divide-y divide-border rounded-[var(--radius)] border border-border">
        {rows.map(([section, what]) => (
          <div key={section} className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:gap-4">
            <span className="font-medium text-foreground sm:w-56 sm:shrink-0">{section}</span>
            <span>{what}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
