// scrape-test.ts — the real gate for the scraper spine. Headless connect ->
// scrape -> promote against a REAL personal bank account. It exercises the
// same two-process spawn boundary the sync route now uses (issue #92): a
// FETCHER (scripts/scrape-worker.mts) that decrypts its own credentials and
// scrapes with no DB/DK, then a PROMOTER (scripts/promote-worker.mts) that
// persists the normalized records with the DK.
//
// Because the stored `credentials_ct` can only be opened with CK (a WebAuthn
// assertion no CLI can perform), this gate does NOT read the real ciphertext.
// It mints an EPHEMERAL random CK, encrypts the operator-supplied credentials
// under it into a synthetic `credentials_ct`, and hands the fetcher
// [ephemeralCK, syntheticCt] — proving the exact fetcher decrypt + scrape path
// without needing the passkey. The promoter then runs with the real DK.
//
// Nobody but the owner can run this meaningfully — no real bank credentials
// exist in this environment. It must typecheck, lint, and be structurally
// correct; that is where automated verification of this file stops.
//
// Usage:
//   echo '{"password":"<moni-login-password>","credentials":{"username":"...","password":"..."}}' \
//     | npm run scrape:test -- --user dana@moni.demo --connector leumi [--start-date 2026-01-01]
//
// Credentials come from stdin, NEVER argv — argv is visible in `ps` and shell
// history (docs/security/threat-model.md §5). The Moni login password unlocks
// the data key (DK); the connection row must already exist (created in the app
// with the credential window armed by a passkey).
import "dotenv/config";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { authenticate } from "@/domain/auth";
import { findConnectionByConnector, type ConnectionView } from "@/domain/connections";
import { markSyncRunFailed, startSyncRun } from "@/domain/sync-promotion";
import { destroySession, getSession } from "@/lib/auth/session-store";
import { encryptField, wipe } from "@/lib/crypto";
import { encodeBinaryChildFrame, isConnectorId } from "@/lib/connectors";
import { fetcherEnv } from "@/lib/connectors/bank-sync";
import { workerRuntimePath } from "@/lib/worker-runtime";

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
  /** The user's Moni login password — unlocks DK. */
  password: string;
  /** The bank/card login fields, matching src/lib/connectors' registry. */
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

/** Spawns a worker, writes the framed stdin, and resolves with its final
 * parsed stdout line. stderr stays "inherit": this is an interactive gate whose
 * whole point is watching the scraper's own output, and the operator already
 * typed the credentials. Do NOT enable Puppeteer `verbose` while inheriting. */
async function spawnWorker(
  script: string,
  frame: Buffer,
  env?: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const tsxBin = workerRuntimePath("node_modules", ".bin", "tsx");
  const workerPath = workerRuntimePath("scripts", script);
  return new Promise((resolve, reject) => {
    // `env: undefined` inherits the parent's full environment — what the
    // promoter needs (DATABASE_URL). The fetcher is handed a stripped env.
    const child = spawn(tsxBin, [workerPath], { stdio: ["pipe", "pipe", "inherit"], env });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", () => {
      const line = stdout.trim().split("\n").filter(Boolean).pop();
      if (!line) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(line) as Record<string, unknown>);
      } catch {
        reject(new Error(`${script} printed non-JSON output: ${line}`));
      }
    });
    child.stdin.write(frame);
    child.stdin.end();
  });
}

/** Isolate the fetcher exactly like the production sync path (no DATABASE_URL,
 * no app secrets), but re-add the failure-screenshot path that production
 * withholds: here an operator is watching and may want it for debugging. */
function fetcherTestEnv(): NodeJS.ProcessEnv {
  const env = fetcherEnv();
  const screenshot = process.env.MONI_SCRAPE_FAILURE_SCREENSHOT;
  if (screenshot) (env as Record<string, string>).MONI_SCRAPE_FAILURE_SCREENSHOT = screenshot;
  return env;
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

      const connection: ConnectionView | null = await findConnectionByConnector(
        session.userId,
        connectorId,
      );
      if (!connection) {
        throw new Error(
          `No "${connectorId}" connection exists for ${args.user}. Create it in the app ` +
            `first (Settings -> Add connection, unlocking with your passkey), then re-run.`,
        );
      }
      console.log(`Using connection ${connection.id} for connector "${connectorId}".`);

      const syncRunId = await startSyncRun(session.userId, connection.id);
      console.log(`sync_runs ${syncRunId}: running`);

      // Mint an ephemeral CK and a synthetic ciphertext so the fetcher runs its
      // real decrypt path without needing the passkey-gated stored CK.
      const ephemeralCk = Buffer.from(randomBytes(32));
      const version = 1;
      const credentialsPlaintext = Buffer.from(JSON.stringify(stdin.credentials), "utf8");
      const ciphertext = encryptField(ephemeralCk, credentialsPlaintext, {
        rowId: connection.id,
        column: "credentials_ct",
        version,
      });
      credentialsPlaintext.fill(0);
      const fetchFrame = encodeBinaryChildFrame(
        {
          connectionId: connection.id,
          connectorId,
          startDate: args.startDate,
          version: String(version),
        },
        [ephemeralCk, ciphertext],
      );
      ephemeralCk.fill(0);
      ciphertext.fill(0);

      let fetched: Record<string, unknown>;
      try {
        fetched = await spawnWorker("scrape-worker.mts", fetchFrame, fetcherTestEnv());
      } finally {
        fetchFrame.fill(0);
      }
      if (!Array.isArray(fetched.accounts)) {
        const code = typeof fetched.code === "string" ? fetched.code : "no_output";
        console.error(`sync_runs ${syncRunId}: fetch failed — ${code}`);
        await markSyncRunFailed(session.userId, syncRunId, code);
        process.exitCode = 1;
        return;
      }

      const dataKeyCopy = Buffer.from(session.dataKey);
      const accountsBuffer = Buffer.from(JSON.stringify({ accounts: fetched.accounts }));
      const promoteFrame = encodeBinaryChildFrame(
        { userId: session.userId, connectionId: connection.id, connectorId, syncRunId },
        [dataKeyCopy, accountsBuffer],
      );
      dataKeyCopy.fill(0);
      accountsBuffer.fill(0);
      let promoted: Record<string, unknown>;
      try {
        promoted = await spawnWorker("promote-worker.mts", promoteFrame);
      } finally {
        promoteFrame.fill(0);
      }
      if (promoted.ok !== true) {
        console.error(`sync_runs ${syncRunId}: promote failed`);
        process.exitCode = 1;
        return;
      }

      console.log(`sync_runs ${syncRunId}: succeeded`);
      console.log(JSON.stringify(promoted.summary, null, 2));
    } finally {
      // NOT session.dataKey — destroySession() wipes that key itself.
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
