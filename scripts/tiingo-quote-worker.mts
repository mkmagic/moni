import "dotenv/config";
import { withUser } from "@/db/client";
import { listTiingoQuoteTargets, replaceTiingoQuote } from "@/domain/investment-valuation";
import { readChildStdin } from "@/lib/connectors";
import { fetchTiingoEodQuote, runTiingoQuoteWorkerFrame } from "@/lib/investments";

async function main(): Promise<void> {
  const frame = await readChildStdin(process.stdin);
  await runTiingoQuoteWorkerFrame(frame, async ({ userId, dataKey, token }) => {
    await refreshTiingoQuotes({
      dataKey,
      token,
      fetcher: fetch,
      listTargets: (dataKey) => withUser(userId, (tx) => listTiingoQuoteTargets(tx, dataKey)),
      fetchQuote: fetchTiingoEodQuote,
      replaceQuote: (dataKey, input) =>
        withUser(userId, (tx) =>
          replaceTiingoQuote(tx, dataKey, { ...input, qualityState: "accepted" }),
        ),
    });
  });
}

main().catch(() => {
  process.exitCode = 1;
});
