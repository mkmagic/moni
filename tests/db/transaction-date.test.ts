// src/domain/sync-promotion.ts + src/domain/transactions.ts — a transaction's
// date is the Israel-local calendar day, and the user can correct it by hand.
//
// The Israeli scrapers build `date` by parsing a local date and calling
// `moment(...).toISOString()`, so a bank value-date of 2026-09-01 in Israel
// arrives as the instant 2026-08-31T21:00:00Z. `entries.date` is a Postgres
// DATE, whose input parser keeps only the leading YYYY-MM-DD and drops the
// zone — so that instant truncated to 2026-08-31, a day early. The fix is to
// normalize the instant to the Asia/Jerusalem calendar day before storing.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { withUser } from "@/db/client";
import * as schema from "@/db/schema";
import { createUser } from "@/domain/registration";
import { createConnection } from "@/domain/connections";
import { promoteScrapeResult, startSyncRun } from "@/domain/sync-promotion";
import { setEntryDate, listEntries } from "@/domain/transactions";
import { isFieldLocked } from "@/domain/attribute-locks";
import type { Session } from "@/lib/auth/session-store";
import type { ScraperAccount, ScraperTransaction } from "@/lib/connectors";
import { cleanupOwners, enrollTestCredentialKey } from "./helpers";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN;
if (!SIGNUP_TOKEN) {
  throw new Error("MONI_SIGNUP_TOKEN must be set in the test environment (see .env.example)");
}

interface Fixture {
  userId: string;
  dataKey: Buffer;
  connectionId: string;
}

async function freshFixture(label: string): Promise<Fixture> {
  const email = `${label}-${randomUUID()}@test.moni`;
  const password = Buffer.from("correct horse battery staple", "utf8");
  const { userId, dataKey } = await createUser(email, password, SIGNUP_TOKEN!);
  const credentialKey = await enrollTestCredentialKey(userId);
  const { id: connectionId } = await createConnection(
    userId,
    "isracard",
    { id: "123456789", card6Digits: "123456", password: "hunter2" },
    credentialKey,
  );
  return { userId, dataKey, connectionId };
}

function accountWith(txns: ScraperTransaction[]): ScraperAccount[] {
  return [{ accountNumber: "4580", currency: "ILS", txns }];
}

/** A salary the bank value-dates 2026-09-01 in Israel; the scraper hands it to
 * us as that instant in UTC — the evening before. */
function salary(overrides: Partial<ScraperTransaction> = {}): ScraperTransaction {
  return {
    type: "normal",
    identifier: "SALARY-1",
    date: "2026-08-31T21:00:00.000Z",
    processedDate: "2026-08-31T21:00:00.000Z",
    originalAmount: 12000,
    originalCurrency: "ILS",
    chargedAmount: 12000,
    chargedCurrency: "ILS",
    description: "ACME Payroll",
    status: "completed",
    ...overrides,
  };
}

async function promote(fx: Fixture, accounts: ScraperAccount[]) {
  const syncRunId = await startSyncRun(fx.userId, fx.connectionId);
  return promoteScrapeResult({
    userId: fx.userId,
    dataKey: fx.dataKey,
    connectionId: fx.connectionId,
    connectorId: "isracard",
    syncRunId,
    accounts,
  });
}

function session(fx: Fixture): Session {
  return { userId: fx.userId, dataKey: fx.dataKey } as Session;
}

async function onlyEntry(fx: Fixture) {
  const rows = await listEntries(session(fx), {});
  expect(rows).toHaveLength(1);
  return rows[0];
}

describe("transaction date", () => {
  const createdUserIds: string[] = [];
  afterAll(async () => cleanupOwners(createdUserIds));

  it("stores the Israel-local day, not the UTC-truncated day, for an evening-UTC scraper date", async () => {
    const fx = await freshFixture("date-tz");
    createdUserIds.push(fx.userId);

    await promote(fx, accountWith([salary()]));

    expect((await onlyEntry(fx)).date).toBe("2026-09-01");
  });

  it("lets a user correct a transaction's date, and locks it", async () => {
    const fx = await freshFixture("date-edit");
    createdUserIds.push(fx.userId);

    await promote(fx, accountWith([salary({ date: "2026-08-31", processedDate: "2026-08-31" })]));
    const before = await onlyEntry(fx);
    expect(before.date).toBe("2026-08-31");

    await setEntryDate(session(fx), before.id, "2026-09-01");

    const after = await onlyEntry(fx);
    expect(after.date).toBe("2026-09-01");
    expect(after.dateLocked).toBe(true);

    const [raw] = await withUser(fx.userId, (tx) => tx.select().from(schema.entries));
    expect(isFieldLocked(raw.lockedAttributes, "date")).toBe(true);
  });

  it("does not let a later scrape re-date an entry the user fixed by hand", async () => {
    const fx = await freshFixture("date-lock-resync");
    createdUserIds.push(fx.userId);

    // A slice arrives pending on its purchase date, so the pending -> posted
    // branch would normally re-date it when the charge date lands.
    const pending = salary({
      type: "installments",
      identifier: 77700123,
      date: "2026-08-10",
      processedDate: "2026-08-10",
      status: "pending",
      installments: { number: 1, total: 3 },
    });
    await promote(fx, accountWith([pending]));
    const entry = await onlyEntry(fx);

    await setEntryDate(session(fx), entry.id, "2026-09-01");

    // The real charge date now arrives — but the user's date must win.
    await promote(
      fx,
      accountWith([{ ...pending, processedDate: "2026-08-25", status: "completed" }]),
    );

    expect((await onlyEntry(fx)).date).toBe("2026-09-01");
  });
});
