/**
 * POC (throwaway): can we read Schwab holdings from SnapTrade instead of the manual CSV?
 *
 * Run:  SNAPTRADE_CLIENT_ID=... SNAPTRADE_CONSUMER_KEY=... npx tsx scripts/poc-snaptrade-holdings.mts
 * or put those two keys in .env.local and run:  npx tsx scripts/poc-snaptrade-holdings.mts
 *
 * Add --raw to dump the untouched JSON bodies (contains your account numbers).
 *
 * This is NOT wired into the app: no DB, no encryption, no domain layer. It only answers
 * "does the data arrive, and does it arrive in a shape InvestmentSyncEnvelope can accept".
 */
import { config as loadEnv } from "dotenv";
import { Snaptrade, SnaptradeAuth } from "snaptrade-typescript-sdk";

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ quiet: true });

const RAW = process.argv.includes("--raw");

/**
 * The SDK hands back `number` for every money field, so JSON.parse has already rounded
 * through a float before we see it. Moni may never do that, so the POC keeps the response
 * as text and quotes every numeric literal before parsing — the digits the broker sent survive.
 */
function parseJsonPreservingNumbers(text: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      out += char;
      if (char === "\\") {
        i += 1;
        out += text[i];
      } else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    const number = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    // Whitespace-insensitive: see the fixed version in src/lib/investments/snaptrade.ts.
    if (number && /[:,[]\s*$/.test(out)) {
      out += `"${number[0]}"`;
      i += number[0].length - 1;
      continue;
    }
    out += char;
  }
  return JSON.parse(out);
}

type Json = Record<string, unknown>;
const asRecord = (value: unknown): Json => (value ?? {}) as Json;
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

function main(): void {
  const clientId = process.env.SNAPTRADE_CLIENT_ID;
  const consumerKey = process.env.SNAPTRADE_CONSUMER_KEY;
  if (!clientId || !consumerKey) {
    console.error(
      "Missing SNAPTRADE_CLIENT_ID / SNAPTRADE_CONSUMER_KEY (env or .env.local).\n" +
        "Both come from the SnapTrade dashboard; the consumer key is a secret.",
    );
    process.exitCode = 1;
    return;
  }

  const snaptrade = new Snaptrade({
    auth: SnaptradeAuth.personalApiKey({ clientId, consumerKey }),
    // Keep bodies as text so parseJsonPreservingNumbers, not JSON.parse, decides what a number is.
    baseOptions: { transformResponse: [(body: string) => body] },
  });

  run(snaptrade).catch((error: unknown) => {
    const response = asRecord(asRecord(error).response);
    console.error(
      `SnapTrade call failed: ${response.status ?? ""} ${String(response.data ?? asRecord(error).message ?? error)}`,
    );
    process.exitCode = 1;
  });
}

type SnaptradeClient = Snaptrade<ReturnType<typeof SnaptradeAuth.personalApiKey>>;

async function run(snaptrade: SnaptradeClient): Promise<void> {
  const accountsResponse = await snaptrade.accountInformation.listUserAccounts();
  const accounts = parseJsonPreservingNumbers(accountsResponse.data as unknown as string);
  if (!Array.isArray(accounts)) {
    console.error("Unexpected accounts payload:", accounts);
    process.exitCode = 1;
    return;
  }
  if (RAW) console.log("--- accounts ---\n", JSON.stringify(accounts, null, 2));

  console.log(`Connected accounts: ${accounts.length}`);
  for (const entry of accounts) {
    const account = asRecord(entry);
    const id = str(account.id);
    console.log(
      `\n== ${str(account.institution_name) ?? "?"} / ${str(account.name) ?? "(unnamed)"} ` +
        `(${str(account.number) ?? "?"})  id=${id}`,
    );
    console.log(`   sync status: ${JSON.stringify(account.sync_status ?? null)}`);
    const total = asRecord(asRecord(account.balance).total);
    console.log(`   broker total: ${str(total.amount) ?? "?"} ${str(total.currency) ?? "?"}`);
    if (!id) continue;

    const balanceResponse = await snaptrade.accountInformation.getUserAccountBalance({
      accountId: id,
    });
    const balances = parseJsonPreservingNumbers(balanceResponse.data as unknown as string);
    if (RAW) console.log("--- balances ---\n", JSON.stringify(balances, null, 2));
    for (const item of Array.isArray(balances) ? balances : []) {
      const balance = asRecord(item);
      console.log(
        `   cash: ${str(balance.cash) ?? "?"} ${str(asRecord(balance.currency).code) ?? "?"}`,
      );
    }

    const positionsResponse = await snaptrade.accountInformation.getAllAccountPositions({
      accountId: id,
    });
    const positions = parseJsonPreservingNumbers(positionsResponse.data as unknown as string);
    if (RAW) console.log("--- positions ---\n", JSON.stringify(positions, null, 2));

    const rows = Array.isArray(positions) ? positions : [];
    console.log(`   positions: ${rows.length}`);
    for (const item of rows) {
      const position = asRecord(item);
      const symbol = asRecord(asRecord(position.symbol).symbol);
      console.log(
        [
          `   - ${str(symbol.symbol) ?? "?"}`,
          `qty=${str(position.units) ?? str(position.fractional_units) ?? "?"}`,
          `price=${str(position.price) ?? "?"}`,
          `ccy=${str(asRecord(position.currency).code) ?? str(asRecord(symbol.currency).code) ?? "?"}`,
          `type=${str(asRecord(symbol.type).code) ?? "?"}`,
          `openPnl=${str(position.open_pnl) ?? "-"}`,
        ].join("  "),
      );
      // Fields InvestmentSyncEnvelope needs that SnapTrade may not carry:
      const gaps = [
        position.units === undefined && position.fractional_units === undefined ? "quantity" : null,
        position.price === undefined ? "price" : null,
        symbol.symbol === undefined ? "symbol" : null,
      ].filter(Boolean);
      if (gaps.length) console.log(`     MISSING for Moni: ${gaps.join(", ")}`);
    }
  }

  console.log(
    "\nNote: SnapTrade has no per-position market value — Moni's envelope wants sourceValue, " +
      "so it must be derived as units x price with the decimal library. See the write-up.",
  );
}

main();
