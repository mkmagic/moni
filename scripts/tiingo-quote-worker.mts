import "dotenv/config";
import {
  listTiingoQuoteTargetsForUser,
  replaceTiingoQuoteForUser,
} from "@/domain/investment-valuation";
import { readChildStdin } from "@/lib/connectors";
import { fetchTiingoEodQuote, runTiingoQuoteWorkerFrame } from "@/lib/investments";

async function main(): Promise<void> {
  const frame = await readChildStdin(process.stdin);
  await runTiingoQuoteWorkerFrame(frame, async ({ userId, dataKey, token }) => {
    await refreshTiingoQuotes({
      dataKey,
      token,
      fetcher: fetch,
      listTargets: (dataKey) => listTiingoQuoteTargetsForUser(userId, dataKey),
      fetchQuote: fetchTiingoEodQuote,
      replaceQuote: (dataKey, input) =>
        replaceTiingoQuoteForUser(userId, dataKey, { ...input, qualityState: "accepted" }),
    });
  });
}

main().catch(() => {
  process.exitCode = 1;
});
