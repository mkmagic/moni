import "dotenv/config";
import { decodeBinaryChildFrame, readChildStdin } from "@/lib/connectors";
import { fetchBoiRates } from "@/lib/investments";
import { upsertBoiFxRate } from "@/domain/fx-rates";
import { wipe } from "@/lib/crypto";

async function main(): Promise<void> {
  const frame = await readChildStdin(process.stdin);
  let segments: Buffer[] = [];
  try {
    const decoded = decodeBinaryChildFrame(frame);
    segments = decoded.segments;
    const required = decoded.metadata.required;
    if (!Array.isArray(required) || segments.length !== 0) throw new Error("invalid_frame");
    const rates = await fetchBoiRates(required as Array<{ currency: string; date: string }>, fetch);
    for (const rate of rates)
      await upsertBoiFxRate({ fromCurrency: rate.currency, date: rate.date, rate: rate.rate });
    process.stdout.write(JSON.stringify({ ok: true, count: rates.length }) + "\n");
  } finally {
    for (const segment of segments) wipe(segment);
    wipe(frame);
  }
}
main().catch(() => {
  process.exitCode = 1;
});
