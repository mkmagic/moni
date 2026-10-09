import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Card } from "@/components/ui/card";
import { AiSetupPrompt } from "../ai-setup-prompt";
import { Note, Path, Shot, Step } from "../setup-guide";
import { SNAPTRADE_SETUP_PROMPT } from "./ai-prompt";

/** The one-time SnapTrade setup a new user needs before the SnapTrade
 * connection can sync. Reached only from that connector's login fields
 * ("How do I get these?"), like the IBKR guide. snaptrade.ts signs its
 * requests with a SnapTrade *Personal* API key — no userId/userSecret — so the
 * user needs their own free Personal account with their brokerages already
 * linked in SnapTrade's dashboard; there is no shortcut around that.
 * Screenshots were taken from a real dashboard (personal details masked) and
 * live in public/help/snaptrade/. Labels here are SnapTrade's exact on-screen
 * text — keep them, and the AI prompt, in step with the dashboard. */
export default function SnaptradeSetupGuidePage() {
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div>
        <Link
          href="/settings/connections"
          className="mb-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground transition hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to connections
        </Link>
        <h2 className="text-lg font-semibold text-foreground">Connect SnapTrade</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          SnapTrade links brokerages such as Schwab and Vanguard to apps like Moni. You make a free
          SnapTrade <em>Personal</em> account, link your brokerages there, and come back with two
          things to paste into Moni: a <strong>Client ID</strong> and a{" "}
          <strong>Consumer Key</strong>. It takes about ten minutes. Moni only ever reads from
          SnapTrade — it can&apos;t place trades or move money.
        </p>
      </div>

      <AiSetupPrompt prompt={SNAPTRADE_SETUP_PROMPT}>
        If you use an AI assistant that can control your browser, such as Claude in Chrome or Codex,
        give it a ready-made prompt. You sign up and log in yourself — to SnapTrade and to each
        brokerage; the assistant finds the right screens, checks every connection is read-only, and
        shows you where the two values are. It never touches your keys.
      </AiSetupPrompt>

      <Step n={1} title="Create a free SnapTrade account">
        <p>
          Sign up at{" "}
          <a
            href="https://dashboard.snaptrade.com/signup"
            target="_blank"
            rel="noreferrer"
            className="font-medium text-primary hover:underline"
          >
            dashboard.snaptrade.com/signup
          </a>{" "}
          and verify your email. A Personal account is free and has room for 20 brokerage
          connections.
        </p>
      </Step>

      <Step n={2} title="Turn on two-factor sign-in">
        <p>
          SnapTrade won&apos;t give you API keys until two-factor sign-in is on. Click your name at
          the bottom left, then <Path>Account settings</Path> and the <Path>Security</Path> tab.
          Next to <Path>Authenticator app</Path>, click <Path>Turn on</Path> and scan the code with
          an authenticator app on your phone.
        </p>
        <Shot
          src="/help/snaptrade/02-security-2fa.webp"
          alt="Account settings, Security tab, with the Authenticator app row marked"
          height={878}
        />
      </Step>

      <Step n={3} title="Link your brokerages — choose Read-only">
        <p>
          Go to <Path>Home</Path>. Under <Path>Connections</Path>, click{" "}
          <Path>Connect another account</Path>.
        </p>
        <p>
          SnapTrade asks <Path>What should this connection allow?</Path> Keep <Path>Read-only</Path>{" "}
          — it&apos;s all Moni needs — and click <Path>Continue</Path>.
        </p>
        <Shot
          src="/help/snaptrade/04-access-choice.webp"
          alt="The access choice, with Read-only and Continue marked"
          height={878}
        />
        <p>
          Under <Path>Select your institution</Path>, search for your brokerage, pick it, and log in
          to the brokerage when asked.
        </p>
        <Shot
          src="/help/snaptrade/05-institution-picker.webp"
          alt="The institution search with Vanguard US found"
          width={450}
          height={483}
        />
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <span className="text-foreground">Schwab</span> sends you to schwab.com to log in, so
            SnapTrade never sees your Schwab password. Schwab asks you to log in again every few
            weeks. When it does, the connection stops updating until you reconnect it in SnapTrade.
            Moni gets about two years of Schwab history, without tax lots, so older holdings start
            out as opening positions.
          </li>
          <li>
            <span className="text-foreground">Vanguard US</span> takes your Vanguard username and
            password inside SnapTrade. Vanguard employer retirement plans, such as a 401(k),
            can&apos;t be read.
          </li>
        </ul>
        <p>
          Repeat for each brokerage. When you&apos;re done, each one is listed under{" "}
          <Path>Connections</Path> with Access <Path>Read-only</Path>.
        </p>
        <Shot
          src="/help/snaptrade/01-home-connections.webp"
          alt="The Connections list, with Connect another account and the Read-only access marked"
          width={754}
          height={231}
        />
      </Step>

      <Step n={4} title="Copy your Client ID and Consumer Key">
        <p>
          In the left menu, open <Path>Build → API Keys</Path>. Your <Path>Personal API Key</Path>{" "}
          has two parts. Use the copy button next to each.
        </p>
        <Note>
          Don&apos;t press <Path>Rotate</Path> unless your Consumer Key has leaked. Rotating
          replaces the key at once, and Moni stops syncing until you paste the new one.
        </Note>
        <Shot
          src="/help/snaptrade/03-api-keys.webp"
          alt="The API Keys page with the Client ID and Consumer Key marked"
          height={878}
        />
        <p>
          The Consumer Key is a password to your brokerage data. Paste it only into Moni, and
          don&apos;t share it with anyone, SnapTrade staff included.
        </p>
      </Step>

      <Step n={5} title="Paste both into Moni, then wait">
        <p>
          Go to{" "}
          <Link
            href="/settings/connections/connect"
            className="font-medium text-primary hover:underline"
          >
            Add a connection
          </Link>
          , choose <Path>SnapTrade</Path>, and paste the Client ID and Consumer Key. The first sync
          starts straight away.
        </p>
        <p>
          SnapTrade copies a newly linked brokerage in the background. Until it has finished, the
          first sync fails with a message saying so. Give it a few hours, then sync again.
        </p>
      </Step>

      <Card className="flex flex-col gap-3 p-6 text-sm leading-relaxed text-muted-foreground">
        <h3 className="text-base font-semibold text-foreground">If something goes wrong</h3>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <span className="text-foreground">No brokerage is linked</span> — link one as in step 3,
            then sync again.
          </li>
          <li>
            <span className="text-foreground">SnapTrade is still doing its first sync</span> — wait
            a few hours after linking a brokerage, then sync again.
          </li>
          <li>
            <span className="text-foreground">Numbers stopped updating</span> — the brokerage
            connection has expired (Schwab does this every few weeks). Reconnect it in the SnapTrade
            dashboard; Moni shows SnapTrade&apos;s last figures until you do.
          </li>
          <li>
            <span className="text-foreground">The broker rejected the request</span> — the Consumer
            Key was rotated or mistyped. Copy it again (step 4), then use{" "}
            <Path>Replace login details</Path> on the connection in Settings › Connections.
          </li>
        </ul>
      </Card>
    </div>
  );
}
