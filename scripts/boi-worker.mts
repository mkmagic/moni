import "dotenv/config";
import { decodeBinaryChildFrame, readChildStdin } from "@/lib/connectors";
import { fetchBoiRates } from "@/lib/investments";
import { upsertBoiFxRate } from "@/domain/fx-rates";
import { wipe } from "@/lib/crypto";
import { errorLabel, syncLog } from "@/lib/sync-log";

async function main(): Promise<void> {
  const frame = await readChildStdin(process.stdin);
  let segments: Buffer[] = [];
  try {
    const decoded = decodeBinaryChildFrame(frame);
    segments = decoded.segments;
    const required = decoded.metadata.required;
    if (!Array.isArray(required) || segments.length !== 0) throw new Error("invalid_frame");
    const pairs = required as Array<{ currency: string; date: string }>;
    syncLog("boi.fetch.start", {
      pairs: pairs.length,
      currencies: [...new Set(pairs.map((pair) => pair.currency))].sort().join(","),
      dates: [...new Set(pairs.map((pair) => pair.date))].sort().join(","),
    });
    const rates = await fetchBoiRates(pairs, fetch);
    for (const rate of rates)
      await upsertBoiFxRate({ fromCurrency: rate.currency, date: rate.date, rate: rate.rate });
    syncLog("boi.fetch.done", {
      rates: rates.length,
      // Rates themselves are public BOI reference data, not user holdings.
      observed: rates.map((rate) => `${rate.currency}@${rate.date}=${rate.rate}`).join(","),
    });
    process.stdout.write(JSON.stringify({ ok: true, count: rates.length }) + "\n");
  } finally {
    for (const segment of segments) wipe(segment);
    wipe(frame);
  }
}
main().catch((error) => {
  syncLog("worker.failed", { script: "boi-worker.mts", error: errorLabel(error) });
  process.exitCode = 1;
});
