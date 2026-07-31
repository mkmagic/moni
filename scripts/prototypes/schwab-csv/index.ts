#!/usr/bin/env node
// PROTOTYPE — throwaway Schwab Positions CSV evidence collector for issue #39.
//
// It reads one original export and writes nothing. The path, account identity,
// timestamp, symbols, quantities, prices, values, and raw CSV are not printed.
import fs from "node:fs/promises";

import { analyzeSchwabPositionsCsv, type SchwabCsvInventory } from "./model";

const MAX_CSV_BYTES = 10 * 1024 * 1024;
const bold = "\x1b[1m";
const dim = "\x1b[2m";
const reset = "\x1b[0m";

class SafeProbeError extends Error {
  constructor(readonly safeCode: string) {
    super(safeCode);
  }
}

function printHelp(): void {
  console.log(`Schwab Positions CSV POC

Question:
  Can one original Schwab Positions CSV plus an explicit account-currency
  confirmation satisfy Moni's complete snapshot contract, reconcile exactly,
  and expose safe inputs for later symbol resolution?

Export:
  1. Sign in to Schwab and open the brokerage account's Positions page.
  2. Export the positions table as CSV without editing or resaving it.
  3. Keep the original CSV local. The probe reads it once and writes nothing.

Run:
  npm run poc:schwab-csv

The terminal asks for the CSV path and account valuation currency. Inputs are
hidden so the path does not appear in terminal output. The result contains only
field names, row counts, and redacted contract evidence.`);
}

async function readHiddenInput(
  label: string,
  maxLength: number,
  allowEmpty = false,
): Promise<Buffer> {
  if (!process.stdin.isTTY) throw new SafeProbeError("interactive_tty_required");

  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const input = Buffer.alloc(maxLength);
    let length = 0;
    process.stdout.write(`${label} (input hidden): `);
    stdin.setRawMode(true);
    stdin.resume();

    const cleanup = (): void => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };

    const fail = (code: string): void => {
      input.fill(0);
      cleanup();
      process.stdout.write("\n");
      reject(new SafeProbeError(code));
    };

    const finish = (): void => {
      if (length === 0 && !allowEmpty) {
        fail("empty_input");
        return;
      }
      const result = Buffer.from(input.subarray(0, length));
      input.fill(0);
      cleanup();
      process.stdout.write("\n");
      resolve(result);
    };

    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        if (byte === 0x03) {
          chunk.fill(0);
          fail("cancelled");
          return;
        }
        if (byte === 0x0d || byte === 0x0a) {
          chunk.fill(0);
          finish();
          return;
        }
        if (byte === 0x7f || byte === 0x08) {
          if (length > 0) {
            length -= 1;
            input[length] = 0;
          }
          continue;
        }
        if (byte < 0x20) continue;
        if (length >= maxLength) {
          chunk.fill(0);
          fail("input_too_long");
          return;
        }
        input[length] = byte;
        length += 1;
      }
      chunk.fill(0);
    };

    stdin.on("data", onData);
  });
}

function renderInventory(inventory: SchwabCsvInventory): boolean {
  console.log(`\n${bold}Redacted CSV inventory${reset}`);
  console.log(`bytes held in RAM: ${inventory.bytes}`);
  console.log(`header row: ${inventory.headerRow}`);
  console.log(`preamble rows: ${inventory.preambleRows}`);
  console.log(`body rows: ${inventory.bodyRows}`);
  console.log(`positions: ${inventory.positionRows}`);
  console.log(`cash rows: ${inventory.cashRows}`);
  console.log(`total rows: ${inventory.totalRows}`);
  console.log(`fields: ${inventory.fields.join(", ")}`);

  console.log(`\n${bold}Snapshot-contract evidence${reset}`);
  for (const result of inventory.snapshotChecks) {
    const marker = result.status === "proven" ? "✓" : "?";
    console.log(`${marker} ${result.status.padEnd(8)} ${result.name} — ${result.evidence}`);
  }

  console.log(`\n${bold}Identity-resolution evidence${reset}`);
  for (const result of inventory.identityChecks) {
    const marker = result.status === "proven" ? "✓" : "?";
    console.log(`${marker} ${result.status.padEnd(8)} ${result.name} — ${result.evidence}`);
  }

  const snapshotComplete = inventory.snapshotChecks.every((result) => result.status === "proven");
  const durableIdentity = inventory.identityChecks.at(-1)?.status === "proven";
  console.log(
    `\n${bold}snapshot verdict${reset}: ${
      snapshotComplete
        ? "field contract proven for this account/export sample"
        : "field contract remains unproven; inspect the unproven source facts"
    }`,
  );
  console.log(
    `${bold}identity verdict${reset}: ${
      durableIdentity
        ? "durable cross-source identity proven"
        : "symbol match candidate available, but automatic cross-source merge requires resolver evidence"
    }`,
  );
  console.log(
    `${dim}An unresolved holding remains separate and still counts in net worth.${reset}`,
  );
  console.log(
    `${dim}No filename, path, account identifier, timestamp, symbol, quantity, price, value, or raw CSV was printed or persisted.${reset}`,
  );
  console.log(
    `${dim}Residual: parsing creates an unwipeable JavaScript string containing the CSV inside this short-lived process; the source Buffer is wiped before exit.${reset}`,
  );
  console.log(
    `${dim}Sample boundary: this result does not prove options, fixed income, mutual funds, short positions, or multi-currency exports.${reset}`,
  );
  return snapshotComplete;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return;
  }

  let pathInput: Buffer | null = null;
  let currencyInput: Buffer | null = null;
  let sourceBuffer: Buffer | null = null;
  let sourcePath = "";
  let source = "";

  try {
    console.log(`${bold}Schwab Positions CSV POC — issue #39${reset}`);
    console.log(`${dim}Nothing is written; source values remain redacted.${reset}\n`);
    pathInput = await readHiddenInput("Original CSV path", 4096);
    currencyInput = await readHiddenInput("Account valuation currency [USD]", 3, true);
    sourcePath = pathInput.toString("utf8").trim();
    const currency = (currencyInput.toString("ascii").trim() || "USD").toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new SafeProbeError("invalid_currency_code");

    const stats = await fs.stat(sourcePath).catch(() => {
      throw new SafeProbeError("csv_not_readable");
    });
    if (!stats.isFile()) throw new SafeProbeError("csv_not_regular_file");
    if (stats.size > MAX_CSV_BYTES) throw new SafeProbeError("csv_too_large");

    sourceBuffer = await fs.readFile(sourcePath).catch(() => {
      throw new SafeProbeError("csv_not_readable");
    });
    if (sourceBuffer.length > MAX_CSV_BYTES) throw new SafeProbeError("csv_too_large");
    source = new TextDecoder("utf-8", { fatal: true }).decode(sourceBuffer);

    const inventory = analyzeSchwabPositionsCsv(source, sourceBuffer.length, currency);
    if (!renderInventory(inventory)) process.exitCode = 1;
  } catch (error) {
    const safeCode =
      error instanceof SafeProbeError
        ? error.safeCode
        : error instanceof TypeError
          ? "invalid_utf8_csv"
          : error instanceof Error &&
              ["unterminated_csv_field", "positions_header_not_found"].includes(error.message)
            ? error.message
            : "unexpected_failure";
    console.error(`\n${bold}Schwab Positions CSV POC failed${reset}`);
    console.error(`safe failure code: ${safeCode}`);
    process.exitCode = 1;
  } finally {
    pathInput?.fill(0);
    currencyInput?.fill(0);
    sourceBuffer?.fill(0);
    sourcePath = "";
    source = "";
  }
}

await main();
