import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { withUser } from "@/db/client";
import { accounts, entries, merchantLookups } from "@/db/schema";
import { createUser } from "@/domain/registration";
import { updateProfile } from "@/domain/profile";
import {
  enrichUnknownMerchants,
  SmartCategorizeDisabledError,
  suggestCategories,
} from "@/domain/categorization";
import { encText } from "@/domain/fields";
import * as externalModule from "@/lib/categorization/external";
import type { Session } from "@/lib/auth/session-store";
import { cleanupOwners } from "./helpers";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN ?? "change-me-dev-signup-token";

const createdUserIds: string[] = [];

async function freshFixture(
  label: string,
): Promise<{ userId: string; dataKey: Buffer; session: Session }> {
  const email = `${label}-${randomUUID()}@test.moni`;
  const password = Buffer.from("correct horse battery staple", "utf8");
  const { userId, dataKey } = await createUser(email, password, SIGNUP_TOKEN!);
  createdUserIds.push(userId);
  const session = { id: randomUUID(), userId, dataKey, baseCurrency: "ILS" } as Session;
  return { userId, dataKey, session };
}

describe("merchantLookups (DB & domain)", () => {
  afterAll(async () => {
    await cleanupOwners(createdUserIds);
  });

  it("enforces RLS tenant isolation: two users' lookups are invisible to each other", async () => {
    const user1 = await freshFixture("rls1");
    const user2 = await freshFixture("rls2");

    const id = randomUUID();
    await withUser(user1.userId, async (tx) => {
      await tx.insert(merchantLookups).values({
        id,
        ownerId: user1.userId,
        matchTextCt: encText(user1.dataKey, "shufersal", id, "match_text_ct", 1),
        builtinKey: "food-groceries",
        confidence: "high",
        model: "test-model",
        promptVersion: 1,
      });
    });

    const user1Lookups = await withUser(user1.userId, (tx) => tx.select().from(merchantLookups));
    expect(user1Lookups).toHaveLength(1);

    const user2Lookups = await withUser(user2.userId, (tx) => tx.select().from(merchantLookups));
    expect(user2Lookups).toHaveLength(0);
  });

  it("enrichUnknownMerchants throws SmartCategorizeDisabledError when setting is off", async () => {
    const { session } = await freshFixture("disabled");
    vi.stubEnv("MONI_LLM_API_KEY", "test-api-key");

    await expect(enrichUnknownMerchants(session)).rejects.toThrow(SmartCategorizeDisabledError);
  });

  it("a second enrichment run does not re-ask for a text already cached, including unknown", async () => {
    const { userId, dataKey, session } = await freshFixture("enrich");
    await updateProfile(userId, { smartCategorize: true });
    vi.stubEnv("MONI_LLM_API_KEY", "test-api-key");

    // Create an account & uncategorized entry
    const accountId = randomUUID();
    await withUser(userId, async (tx) => {
      await tx.insert(accounts).values({
        id: accountId,
        ownerId: userId,
        nameCt: encText(dataKey, "Bank Account", accountId, "name_ct", 1),
        accountType: "checking",
        classification: "asset",
        currency: "ILS",
      });

      const entryId = randomUUID();
      await tx.insert(entries).values({
        id: entryId,
        ownerId: userId,
        accountId,
        entryType: "transaction",
        date: "2026-06-01",
        descriptionCt: encText(dataKey, "some unknown merchant text", entryId, "description_ct", 1),
        enteredAmountCt: encText(dataKey, "-50.00", entryId, "entered_amount_ct", 1),
        enteredCurrency: "ILS",
        accountAmountCt: encText(dataKey, "-50.00", entryId, "account_amount_ct", 1),
        accountCurrency: "ILS",
        reportingCurrency: "ILS",
        fxStatus: "locked",
        source: "manual",
        status: "posted",
      });
    });

    const spy = vi.spyOn(externalModule, "classifyBatch").mockResolvedValue(
      new Map([
        [
          0,
          {
            key: "unknown",
            brand: "",
            confidence: "low",
            why: "not recognized",
          },
        ],
      ]),
    );

    // Run 1: asks LLM and caches builtinKey = null
    const res1 = await enrichUnknownMerchants(session);
    expect(res1).toEqual({ looked_up: 1, placed: 0 });
    expect(spy).toHaveBeenCalledTimes(1);

    // Run 2: finds text already in merchant_lookups, skips LLM call
    const res2 = await enrichUnknownMerchants(session);
    expect(res2).toEqual({ looked_up: 0, placed: 0 });
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockRestore();
  });

  it("dedupe works despite randomized ciphertext — same match text written twice produces one logical answer", async () => {
    const { userId, dataKey, session } = await freshFixture("dedupe");

    const matchText = "אופטיקה הלפרין אלמונית";
    const id1 = randomUUID();
    const id2 = randomUUID();
    await withUser(userId, async (tx) => {
      await tx.insert(merchantLookups).values({
        id: id1,
        ownerId: userId,
        matchTextCt: encText(dataKey, matchText, id1, "match_text_ct", 1),
        builtinKey: "food-groceries",
        confidence: "high",
        model: "test-model",
        promptVersion: 1,
      });

      await tx.insert(merchantLookups).values({
        id: id2,
        ownerId: userId,
        matchTextCt: encText(dataKey, matchText, id2, "match_text_ct", 1),
        builtinKey: "food-groceries",
        confidence: "high",
        model: "test-model",
        promptVersion: 1,
      });
    });

    const targetId1 = randomUUID();
    const targetId2 = randomUUID();
    const suggestions = await suggestCategories(session, [
      { id: targetId1, matchText },
      { id: targetId2, matchText },
    ]);

    expect(suggestions[targetId1]).toBeDefined();
    expect(suggestions[targetId1].matchedSource).toBe("external");
    expect(suggestions[targetId2]).toBeDefined();
  });

  it("the direction guard suppresses an income-classified suggestion on a debit entry", async () => {
    const { userId, dataKey, session } = await freshFixture("dirguard");

    const matchText = "xyzzy_custom_merchant_99";
    const lookupId = randomUUID();
    await withUser(userId, async (tx) => {
      await tx.insert(merchantLookups).values({
        id: lookupId,
        ownerId: userId,
        matchTextCt: encText(dataKey, matchText, lookupId, "match_text_ct", 1),
        builtinKey: "income-investments",
        confidence: "high",
        model: "test-model",
        promptVersion: 1,
      });
    });

    const accountId = randomUUID();
    const debitEntryId = randomUUID();
    const creditEntryId = randomUUID();

    await withUser(userId, async (tx) => {
      await tx.insert(accounts).values({
        id: accountId,
        ownerId: userId,
        nameCt: encText(dataKey, "Bank Account", accountId, "name_ct", 1),
        accountType: "checking",
        classification: "asset",
        currency: "ILS",
      });

      // Debit entry (-100 ILS)
      await tx.insert(entries).values({
        id: debitEntryId,
        ownerId: userId,
        accountId,
        entryType: "transaction",
        date: "2026-06-01",
        descriptionCt: encText(dataKey, matchText, debitEntryId, "description_ct", 1),
        enteredAmountCt: encText(dataKey, "-100.00", debitEntryId, "entered_amount_ct", 1),
        enteredCurrency: "ILS",
        accountAmountCt: encText(dataKey, "-100.00", debitEntryId, "account_amount_ct", 1),
        accountCurrency: "ILS",
        reportingCurrency: "ILS",
        fxStatus: "locked",
        source: "manual",
        status: "posted",
      });

      // Credit entry (+100 ILS)
      await tx.insert(entries).values({
        id: creditEntryId,
        ownerId: userId,
        accountId,
        entryType: "transaction",
        date: "2026-06-01",
        descriptionCt: encText(dataKey, matchText, creditEntryId, "description_ct", 1),
        enteredAmountCt: encText(dataKey, "100.00", creditEntryId, "entered_amount_ct", 1),
        enteredCurrency: "ILS",
        accountAmountCt: encText(dataKey, "100.00", creditEntryId, "account_amount_ct", 1),
        accountCurrency: "ILS",
        reportingCurrency: "ILS",
        fxStatus: "locked",
        source: "manual",
        status: "posted",
      });
    });

    // Debit entry should be suppressed by direction guard (income category on debit)
    const suggestionsDebit = await suggestCategories(session, [{ id: debitEntryId, matchText }]);
    expect(suggestionsDebit[debitEntryId]).toBeUndefined();

    // Credit entry should clear direction guard
    const suggestionsCredit = await suggestCategories(session, [{ id: creditEntryId, matchText }]);
    expect(suggestionsCredit[creditEntryId]).toBeDefined();
    expect(suggestionsCredit[creditEntryId].matchedSource).toBe("external");
  });
});
