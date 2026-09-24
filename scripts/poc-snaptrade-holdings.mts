/**
 * POC (throwaway): can we read Schwab holdings from SnapTrade instead of the manual CSV?
 * And can its activity history rebuild tax lots, standing in for the paid tax-lot feature?
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

    await printActivities(snaptrade, id);
  }

  console.log(
    "\nNote: SnapTrade has no per-position market value — Moni's envelope wants sourceValue, " +
      "so it must be derived as units x price with the decimal library. See the write-up.",
  );
}

/**
 * Can trade history stand in for the paid tax-lot feature? Pages through the account's whole
 * activity history (SnapTrade's default range is everything it knows) and reports how far back
 * it reaches and whether each BUY/SELL carries what a lot needs: date, units, price, currency.
 */
async function printActivities(snaptrade: SnaptradeClient, accountId: string): Promise<void> {
  const activities: Json[] = [];
  const limit = 1000;
  try {
    for (let offset = 0; ; offset += limit) {
      const response = await snaptrade.accountInformation.getAccountActivities({
        accountId,
        offset,
        limit,
      });
      const page = asRecord(parseJsonPreservingNumbers(response.data as unknown as string));
      const rows = Array.isArray(page.data) ? page.data.map(asRecord) : [];
      activities.push(...rows);
      if (RAW) console.log(`--- activities offset=${offset} ---\n`, JSON.stringify(page, null, 2));
      if (rows.length < limit) break;
    }
  } catch (error: unknown) {
    // A plan that does not include activities should show up here, not abort the other accounts.
    const response = asRecord(asRecord(error).response);
    console.log(
      `   activities: FAILED ${response.status ?? ""} ${String(response.data ?? asRecord(error).message ?? error)}`,
    );
    return;
  }

  const dates = activities
    .map((activity) => str(activity.trade_date))
    .filter((date): date is string => date !== undefined)
    .sort();
  console.log(
    `   activities: ${activities.length}  first=${dates[0] ?? "?"}  last=${dates.at(-1) ?? "?"}`,
  );
  const byType = new Map<string, number>();
  for (const activity of activities) {
    const type = str(activity.type) ?? "?";
    byType.set(type, (byType.get(type) ?? 0) + 1);
  }
  console.log(`   by type: ${[...byType].map(([type, n]) => `${type}=${n}`).join("  ")}`);

  const trades = activities.filter((activity) =>
    ["BUY", "SELL"].includes(str(activity.type) ?? ""),
  );
  for (const trade of trades) {
    console.log(
      [
        `   - ${str(trade.trade_date) ?? "?"}`,
        str(trade.type),
        str(asRecord(trade.symbol).symbol) ?? "?",
        `units=${str(trade.units) ?? "?"}`,
        `price=${str(trade.price) ?? "?"}`,
        `amount=${str(trade.amount) ?? "?"}`,
        `fee=${str(trade.fee) ?? "-"}`,
        `ccy=${str(asRecord(trade.currency).code) ?? "?"}`,
        `fx=${str(trade.fx_rate) ?? "-"}`,
      ].join("  "),
    );
    // Fields a tax lot cannot be built without:
    const gaps = [
      trade.trade_date == null ? "trade_date" : null,
      trade.units === undefined ? "units" : null,
      trade.price === undefined ? "price" : null,
      asRecord(trade.currency).code === undefined ? "currency" : null,
      asRecord(trade.symbol).symbol === undefined ? "symbol" : null,
    ].filter(Boolean);
    if (gaps.length) console.log(`     MISSING for a lot: ${gaps.join(", ")}`);
  }
}

main();
