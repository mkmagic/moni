/**
 * Structured, opt-in-in-production logging for the sync and valuation paths.
 *
 * Why this exists: every external fetch in this app happens inside a spawned
 * worker whose stderr was `"ignore"`, under a `main().catch(() => {})` that
 * discarded the error. A failed Tiingo call, a BOI outage, and a promotion
 * that decided "unchanged" all looked identical from the dev terminal —
 * nothing at all.
 *
 * SENSITIVITY: these lines name instrument symbols and provider status codes.
 * Symbols are holdings data, which this app encrypts at rest, so the log is a
 * deliberate exception and is therefore silent in production unless the
 * operator sets MONI_SYNC_DIAGNOSTIC=1. It never prints a credential, a data
 * key, an account reference, or a money amount.
 */

type Field = string | number | boolean | null | undefined;

/** On by default in development; production requires an explicit opt-in. */
export function syncLogEnabled(): boolean {
  if (process.env.MONI_SYNC_DIAGNOSTIC === "1") return true;
  if (process.env.MONI_SYNC_DIAGNOSTIC === "0") return false;
  return process.env.NODE_ENV !== "production";
}

function render(value: Field): string {
  if (value === null || value === undefined) return "-";
  const text = String(value);
  // One event per line, and a field that swallowed a newline would forge a
  // second event.
  return /[\s"]/.test(text) ? JSON.stringify(text) : text;
}

/**
 * Writes one line to stderr. Workers inherit stderr from the route, so a
 * child's events land in the same `npm run dev` terminal as the parent's.
 */
export function syncLog(event: string, fields: Record<string, Field> = {}): void {
  if (!syncLogEnabled()) return;
  const pairs = Object.entries(fields).map(([key, value]) => `${key}=${render(value)}`);
  process.stderr.write(`[moni:sync] ${new Date().toISOString()} ${event} ${pairs.join(" ")}\n`);
}

/** Times an awaited external call and logs its outcome either way. */
export async function logFetch<T>(
  event: string,
  fields: Record<string, Field>,
  run: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await run();
    syncLog(event, { ...fields, ok: true, ms: Date.now() - started });
    return result;
  } catch (error) {
    syncLog(event, {
      ...fields,
      ok: false,
      ms: Date.now() - started,
      // A WorkerSourceError's message is its own code, which is what makes
      // these safe to print; anything else is reduced to its class name.
      error: errorLabel(error),
    });
    throw error;
  }
}

/** Reduces an unknown throw to something printable that cannot carry a value. */
export function errorLabel(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && code) return code;
  return error.name === "Error" ? error.message.split("\n")[0].slice(0, 120) : error.name;
}
