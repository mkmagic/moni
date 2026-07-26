// scrape-test.ts — the real gate for the scraper spine (docs plan Task 13).
// Headless connect -> scrape -> promote against a REAL personal bank
// account. This is the parent process from docs plan §C: it authenticates,
// resolves/creates a `connections` row, decrypts credentials through the
// domain layer, creates the `sync_runs` row, then spawns
// scripts/scrape-worker.mts as a short-lived child and hands it the data
// key + everything else over the length-prefixed stdin frame — the same
// spawn boundary a real onboarding/sync route will use later.
//
// Nobody but the owner can run this meaningfully — no real bank credentials
// exist in this environment. It must typecheck, lint, and be structurally
// correct; that is where automated verification of this file stops.
//
// Usage:
//   echo '{"password":"<moni-login-password>","credentials":{"username":"...","password":"..."}}' \
//     | npm run scrape:test -- --user dana@moni.demo --connector leumi [--start-date 2026-01-01]
//
// Credentials come from stdin, NEVER argv — argv is visible in `ps` output
// and shell history, a real exposure for a bank password
// (docs/security/threat-model.md §5). The Moni login password unlocks BOTH
// the data key (DK, to authenticate as the user) and the credential key
// (CK, to encrypt/decrypt `connections.credentials_ct`) — the two RAM
// windows a real onboarding/sync flow opens (docs plan §B).
import "dotenv/config";
import { spawn } from "node:child_process";
import path from "node:path";
import { authenticate, unlockCredentialKey } from "@/domain/auth";
import {
  createConnection,
  findConnectionByConnector,
  getDecryptedCredentials,
  type ConnectionView,
} from "@/domain/connections";
import { startSyncRun } from "@/domain/sync-promotion";
import { destroySession, getSession } from "@/lib/auth/session-store";
import { wipe } from "@/lib/crypto";
import { encodeChildStdinFrame, isConnectorId, type ChildStdinPayload } from "@/lib/connectors";

interface Args {
  user: string;
  connector: string;
  startDate: string;
}

function parseArgs(argv: string[]): Args {
  let user: string | undefined;
  let connector: string | undefined;
  let startDate: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--user") user = argv[++i];
    else if (argv[i] === "--connector") connector = argv[++i];
    else if (argv[i] === "--start-date") startDate = argv[++i];
  }
  if (!user || !connector) {
    throw new Error(
      "Usage: npm run scrape:test -- --user <email> --connector <connectorId> [--start-date YYYY-MM-DD]",
    );
  }
  if (!startDate) {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    startDate = d.toISOString().slice(0, 10);
  }
  return { user, connector, startDate };
}

interface StdinCredentials {
  /** The user's Moni login password — unlocks DK (login) and CK (credentials). */
  password: string;
  /** The bank/card login fields, matching src/lib/connectors' registry for this connector. */
  credentials: Record<string, string>;
}

async function readStdinJson(): Promise<StdinCredentials> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    throw new Error(
      "No stdin input. Pipe JSON: " +
        '{"password":"<moni login password>","credentials":{"username":"...","password":"..."}}',
    );
  }
  const parsed = JSON.parse(raw) as Partial<StdinCredentials>;
  if (!parsed.password || !parsed.credentials) {
    throw new Error(
      'stdin JSON must have "password" (Moni login password) and "credentials" (bank login fields)',
    );
  }
  return { password: parsed.password, credentials: parsed.credentials };
}

/** Spawns scripts/scrape-worker.mts, writes the framed stdin, and resolves
 * with its parsed final stdout line (docs plan §C). */
async function spawnWorker(
  dataKey: Buffer,
  payload: ChildStdinPayload,
): Promise<{ ok: boolean; error?: string; summary?: unknown }> {
  const tsxBin = path.join(process.cwd(), "node_modules", ".bin", "tsx");
  const workerPath = path.join(process.cwd(), "scripts", "scrape-worker.mts");

  return new Promise((resolve, reject) => {
    // stderr stays "inherit" HERE, unlike the sync route (which pipes and
    // redacts): this is an interactive developer command whose whole point is
    // watching the scraper's own output land in your terminal — it's how
    // DEBUG='israeli-bank-scrapers:*' becomes readable. A terminal isn't a
    // persistent server log, and the operator already typed the credentials.
    // Do NOT enable `verbose: true` while inheriting: that turns on Puppeteer
    // protocol logging, which prints the typed password.
    const child = spawn(tsxBin, [workerPath], { stdio: ["pipe", "pipe", "inherit"] });

    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      const line = stdout.trim().split("\n").filter(Boolean).pop();
      if (!line) {
        reject(new Error(`scrape-worker exited (code ${code}) with no parseable output`));
        return;
      }
      try {
        resolve(JSON.parse(line) as { ok: boolean; error?: string; summary?: unknown });
      } catch {
        reject(new Error(`scrape-worker printed non-JSON output: ${line}`));
      }
    });

    child.stdin.write(encodeChildStdinFrame(dataKey, payload));
    child.stdin.end();
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!isConnectorId(args.connector)) {
    throw new Error(`Unknown connector id "${args.connector}"`);
  }
  const connectorId = args.connector;

  const stdin = await readStdinJson();
  const password = Buffer.from(stdin.password, "utf8");

  try {
    const sessionId = await authenticate(args.user, password);
    if (!sessionId) throw new Error(`Login failed for ${args.user}`);

    try {
      const session = getSession(sessionId);
      if (!session) throw new Error("Session vanished immediately after authenticate()");

      const credentialKey = await unlockCredentialKey(session.userId, password);
      if (!credentialKey) throw new Error(`Could not unlock credential key for ${args.user}`);

      try {
        let connection: ConnectionView | null = await findConnectionByConnector(
          session.userId,
          connectorId,
        );
        if (!connection) {
          const created = await createConnection(
            session.userId,
            connectorId,
            stdin.credentials,
            credentialKey,
            `${connectorId} (scrape:test)`,
          );
          connection = {
            id: created.id,
            connectorId,
            displayName: null,
            status: "active",
            lastSyncAt: null,
          };
          console.log(`Created connection ${connection.id} for connector "${connectorId}".`);
        } else {
          console.log(
            `Reusing existing connection ${connection.id} for connector "${connectorId}".`,
          );
        }

        // Re-fetch through the domain layer rather than reusing the
        // stdin-typed credentials directly — this is exactly the read path
        // a real sync route takes (src/domain/connections.ts's
        // getDecryptedCredentials), so this manual gate exercises it too.
        const decrypted = await getDecryptedCredentials(
          session.userId,
          connection.id,
          credentialKey,
        );
        if (!decrypted) throw new Error("Connection vanished immediately after creation/lookup");

        const syncRunId = await startSyncRun(session.userId, connection.id);
        console.log(`sync_runs ${syncRunId}: running`);

        const payload: ChildStdinPayload = {
          syncRunId,
          userId: session.userId,
          connectionId: connection.id,
          connectorId,
          startDate: args.startDate,
          credentials: decrypted.credentials,
        };

        const result = await spawnWorker(session.dataKey, payload);
        if (!result.ok) {
          console.error(`sync_runs ${syncRunId}: failed — ${String(result.error)}`);
          process.exitCode = 1;
          return;
        }

        console.log(`sync_runs ${syncRunId}: succeeded`);
        console.log(JSON.stringify(result.summary, null, 2));
      } finally {
        // This script's own unlocked copy — wiped here (Tier-0 hygiene,
        // threat-model.md §5.5). Not the shared cred-window store, which a
        // one-shot CLI script has no use for.
        wipe(credentialKey);
      }
    } finally {
      // NOT session.dataKey — destroySession() wipes that key itself (docs
      // plan §C's trap #2: never wipe a borrowed session data key
      // yourself). This just tears the session record down.
      destroySession(sessionId);
    }
  } finally {
    wipe(password);
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
