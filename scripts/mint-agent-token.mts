// Mint an agent token from the command line (issue #113). A stopgap until the
// Phase 5 token-management UI lands: minting needs a live password session (the
// only place DK is in RAM), which this reproduces headlessly by authenticating
// against the dev database exactly as the login route does.
//
// Usage:
//   tsx scripts/mint-agent-token.mts <email> <password> [label]
//   tsx scripts/mint-agent-token.mts dana@moni.demo moni-demo "inspector"
//
// Prints the one-time token secret to stdout. Dev/ops only — it takes a
// plaintext password on the command line, so never run it against production
// with a real credential in shell history.
import "dotenv/config";
import { authenticate } from "@/domain/auth";
import { getSession } from "@/lib/auth/session-store";
import { mintToken } from "@/domain/agent-token";
import { wipe } from "@/lib/crypto";

async function main(): Promise<void> {
  const [email, passwordArg, label] = process.argv.slice(2);
  if (!email || !passwordArg) {
    console.error("usage: tsx scripts/mint-agent-token.mts <email> <password> [label]");
    process.exit(2);
  }

  const password = Buffer.from(passwordArg, "utf8");
  let sessionId: string | null;
  try {
    sessionId = await authenticate(email, password);
  } finally {
    wipe(password);
  }
  if (!sessionId) {
    console.error("authentication failed (unknown email or wrong password)");
    process.exit(1);
  }

  const session = getSession(sessionId);
  if (!session) {
    console.error("session vanished immediately after login — unexpected");
    process.exit(1);
  }

  // mintToken reads the live session DK (it copies internally, never wipes it).
  const { tokenId, secret, expiresAt } = await mintToken(session.userId, session.dataKey, {
    label: label ?? "cli",
  });

  console.log(JSON.stringify({ tokenId, expiresAt, secret }, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
