// Promotion gate for src/domain/agam-liderim-promotion.ts — the behaviours only
// a database can show: one Excel becomes many long-term-savings accounts with
// balances, re-importing it is idempotent, an account is matched by policy
// number + provider + product type across imports (pension funds reuse the
// member's ID as the number), a newer import moves the cached balance while an older
// backfill leaves it alone, and an empty portfolio fails having written nothing.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { withUser } from "@/db/client";
import * as schema from "@/db/schema";
import { createUser } from "@/domain/registration";
import { decText, encText } from "@/domain/fields";
import {
  AgamLiderimPromotionError,
  promoteAgamLiderimPortfolio,
} from "@/domain/agam-liderim-promotion";
import {
  listLongTermSavingsAccounts,
  listLongTermSavingsSummaries,
} from "@/domain/long-term-savings";
import type { AgamLiderimAccount } from "@/lib/connectors/agam-liderim";
import type { Session } from "@/lib/auth/session-store";
import { cleanupOwners } from "./helpers";

const SIGNUP_TOKEN = process.env.MONI_SIGNUP_TOKEN;
if (!SIGNUP_TOKEN) throw new Error("MONI_SIGNUP_TOKEN must be set in the test environment");

const owners: string[] = [];
afterAll(() => cleanupOwners(owners));

function account(overrides: Partial<AgamLiderimAccount> = {}): AgamLiderimAccount {
  return {
    policyNumber: "111111111",
    provider: 'בית השקעות דמו בע"מ',
    productType: "קרן פנסיה מקיפה",
    productName: "פנסיית דמו",
    product: "pension",
    status: "פעיל",
    balance: "100000",
    asOf: "2026-07-31",
    joinDate: "2023-01-01",
    ...overrides,
  };
}

const PORTFOLIO: AgamLiderimAccount[] = [
  account(),
  account({
    policyNumber: "222222222",
    provider: 'מנורה דמו בע"מ',
    productType: "קרן השתלמות",
    productName: "השתלמות דמו",
    product: "hishtalmut",
    balance: "15000",
  }),
  account({
    policyNumber: "333333333",
    provider: 'אלטשולר דמו בע"מ',
    productType: "קופת גמל להשקעה",
    productName: "גמל להשקעה דמו",
    product: "gemel_investment",
    balance: "2500",
  }),
];

async function fixture() {
  const { userId, dataKey } = await createUser(
    `${randomUUID()}@test.moni`,
    Buffer.from("test password"),
    SIGNUP_TOKEN!,
  );
  owners.push(userId);
  const connectionId = randomUUID();
  await withUser(userId, async (tx) => {
    await tx.insert(schema.connections).values({
      id: connectionId,
      ownerId: userId,
      connectorId: "agam_liderim",
      mode: "user_mediated_import",
      status: "active",
    });
  });
  const session = { id: randomUUID(), userId, dataKey, baseCurrency: "ILS" } as Session;
  return { userId, dataKey, connectionId, session };
}

async function startRun(userId: string, connectionId: string): Promise<string> {
  const syncRunId = randomUUID();
  await withUser(userId, async (tx) => {
    await tx
      .insert(schema.syncRuns)
      .values({ id: syncRunId, ownerId: userId, connectionId, status: "running" });
  });
  return syncRunId;
}

describe("promoteAgamLiderimPortfolio", () => {
  it("creates one long-term-savings account per row, with balances and liquidity", async () => {
    const ctx = await fixture();
    const syncRunId = await startRun(ctx.userId, ctx.connectionId);
    const result = await promoteAgamLiderimPortfolio({
      userId: ctx.userId,
      connectionId: ctx.connectionId,
      syncRunId,
      dataKey: ctx.dataKey,
      parserId: "agam_liderim_portfolio",
      parserVersion: 1,
      accounts: PORTFOLIO,
    });
    expect(result).toEqual({ accountsProcessed: 3, accountsCreated: 3, balanceSnapshots: 3 });

    const accounts = await listLongTermSavingsAccounts(ctx.session);
    expect(accounts).toHaveLength(3);

    // Each account carries a balance from the snapshot, a provider institution,
    // and the mapped product/liquidity — but no report.
    const pension = accounts.find((a) => a.institution === 'בית השקעות דמו בע"מ')!;
    expect(pension.currentBalance).toEqual({ amount: "100000", currency: "ILS" });
    expect(pension.balanceAsOf).toBe("2026-07-31");
    expect(pension.product).toBe("pension");
    expect(pension.liquidity).toBe("locked_retirement");
    expect(pension.latest).toBeNull();
    expect(pension.reports).toEqual([]);

    const hishtalmut = accounts.find((a) => a.product === "hishtalmut")!;
    expect(hishtalmut.liquidity).toBe("liquid_after");
    expect(hishtalmut.liquidFrom).toBeNull();

    const gemelInv = accounts.find((a) => a.product === "gemel_investment")!;
    expect(gemelInv.liquidity).toBe("liquid");

    // The sync run is marked succeeded with the account count.
    const [run] = await withUser(ctx.userId, (tx) =>
      tx.select().from(schema.syncRuns).where(eq(schema.syncRuns.id, syncRunId)),
    );
    expect(run.status).toBe("succeeded");
    expect(run.promotedAccountCount).toBe(3);

    // Summaries expose freshness from the balance snapshot for balance-only accounts.
    const summaries = await listLongTermSavingsSummaries(ctx.session);
    expect(summaries.get(pension.accountId)?.asOf).toBe("2026-07-31");
  });

  it("is idempotent: re-importing the same file writes no duplicates", async () => {
    const ctx = await fixture();
    const first = await startRun(ctx.userId, ctx.connectionId);
    await promoteAgamLiderimPortfolio({
      userId: ctx.userId,
      connectionId: ctx.connectionId,
      syncRunId: first,
      dataKey: ctx.dataKey,
      parserId: "agam_liderim_portfolio",
      parserVersion: 1,
      accounts: PORTFOLIO,
    });

    const second = await startRun(ctx.userId, ctx.connectionId);
    const result = await promoteAgamLiderimPortfolio({
      userId: ctx.userId,
      connectionId: ctx.connectionId,
      syncRunId: second,
      dataKey: ctx.dataKey,
      parserId: "agam_liderim_portfolio",
      parserVersion: 1,
      accounts: PORTFOLIO,
    });
    expect(result.accountsCreated).toBe(0);
    expect(result.accountsProcessed).toBe(3);

    const accountRows = await withUser(ctx.userId, (tx) => tx.select().from(schema.accounts));
    expect(accountRows).toHaveLength(3);
    // The same as-of date replaced its snapshot rather than stacking a second.
    const snaps = await withUser(ctx.userId, (tx) =>
      tx.select().from(schema.accountBalanceSnapshots),
    );
    expect(snaps).toHaveLength(3);
  });

  it("matches an account by policy number and moves the cached balance on a newer import", async () => {
    const ctx = await fixture();
    const first = await startRun(ctx.userId, ctx.connectionId);
    await promoteAgamLiderimPortfolio({
      userId: ctx.userId,
      connectionId: ctx.connectionId,
      syncRunId: first,
      dataKey: ctx.dataKey,
      parserId: "agam_liderim_portfolio",
      parserVersion: 1,
      accounts: [account({ balance: "100000", asOf: "2026-07-31" })],
    });

    const second = await startRun(ctx.userId, ctx.connectionId);
    await promoteAgamLiderimPortfolio({
      userId: ctx.userId,
      connectionId: ctx.connectionId,
      syncRunId: second,
      dataKey: ctx.dataKey,
      parserId: "agam_liderim_portfolio",
      parserVersion: 1,
      // Same policy, newer date, higher balance.
      accounts: [account({ balance: "123456", asOf: "2026-08-31" })],
    });

    const accountRows = await withUser(ctx.userId, (tx) => tx.select().from(schema.accounts));
    expect(accountRows).toHaveLength(1); // matched, not a second account
    const cached = decText(
      ctx.dataKey,
      accountRows[0].currentBalanceCt,
      accountRows[0].id,
      "current_balance_ct",
      accountRows[0].version,
    );
    expect(cached).toBe("123456");

    const [account0] = await listLongTermSavingsAccounts(ctx.session);
    expect(account0.currentBalance?.amount).toBe("123456");
    expect(account0.balanceAsOf).toBe("2026-08-31");
  });

  it("leaves the cached balance alone when backfilling an older import", async () => {
    const ctx = await fixture();
    const first = await startRun(ctx.userId, ctx.connectionId);
    await promoteAgamLiderimPortfolio({
      userId: ctx.userId,
      connectionId: ctx.connectionId,
      syncRunId: first,
      dataKey: ctx.dataKey,
      parserId: "agam_liderim_portfolio",
      parserVersion: 1,
      accounts: [account({ balance: "100000", asOf: "2026-07-31" })],
    });

    const second = await startRun(ctx.userId, ctx.connectionId);
    await promoteAgamLiderimPortfolio({
      userId: ctx.userId,
      connectionId: ctx.connectionId,
      syncRunId: second,
      dataKey: ctx.dataKey,
      parserId: "agam_liderim_portfolio",
      parserVersion: 1,
      // Older date — a backfill; must not lower today's cached balance.
      accounts: [account({ balance: "80000", asOf: "2026-06-30" })],
    });

    const accountRows = await withUser(ctx.userId, (tx) => tx.select().from(schema.accounts));
    const cached = decText(
      ctx.dataKey,
      accountRows[0].currentBalanceCt,
      accountRows[0].id,
      "current_balance_ct",
      accountRows[0].version,
    );
    expect(cached).toBe("100000");
    // Both dated snapshots are kept as history.
    const snaps = await withUser(ctx.userId, (tx) =>
      tx
        .select()
        .from(schema.accountBalanceSnapshots)
        .where(eq(schema.accountBalanceSnapshots.accountId, accountRows[0].id)),
    );
    expect(snaps.map((s) => s.date).sort()).toEqual(["2026-06-30", "2026-07-31"]);
  });

  it("creates distinct accounts for two rows that share a product name", async () => {
    // A real export held two מגדל השתלמות accounts with the same name but
    // different policy numbers. They must become two accounts, matched by
    // policy, not collapsed into one.
    const ctx = await fixture();
    const syncRunId = await startRun(ctx.userId, ctx.connectionId);
    const twins: AgamLiderimAccount[] = [
      account({
        policyNumber: "10000003",
        provider: 'מגדל מקפת בע"מ',
        productType: "קרן השתלמות",
        productName: "מגדל השתלמות דמו",
        product: "hishtalmut",
        balance: "60000",
      }),
      account({
        policyNumber: "10000004",
        provider: 'מגדל מקפת בע"מ',
        productType: "קרן השתלמות",
        productName: "מגדל השתלמות דמו",
        product: "hishtalmut",
        balance: "61000",
      }),
    ];
    const result = await promoteAgamLiderimPortfolio({
      userId: ctx.userId,
      connectionId: ctx.connectionId,
      syncRunId,
      dataKey: ctx.dataKey,
      parserId: "agam_liderim_portfolio",
      parserVersion: 1,
      accounts: twins,
    });
    expect(result.accountsCreated).toBe(2);

    const accounts = await listLongTermSavingsAccounts(ctx.session);
    expect(accounts).toHaveLength(2);
    expect(accounts.map((a) => a.currentBalance?.amount).sort()).toEqual(["60000", "61000"]);
    // Each carries its own provider + product type + policy number as its ref.
    const refs = await withUser(ctx.userId, (tx) => tx.select().from(schema.accounts));
    const decrypted = refs
      .map((r) =>
        decText(ctx.dataKey, r.externalAccountRefCt, r.id, "external_account_ref_ct", r.version),
      )
      .sort();
    expect(decrypted).toEqual([
      JSON.stringify(["מגדלמקפת", "קרןהשתלמות", "10000003"]),
      JSON.stringify(["מגדלמקפת", "קרןהשתלמות", "10000004"]),
    ]);
  });

  it("keeps two pensions apart when both use the member's ID as the account number", async () => {
    // Israeli pension funds key the account on the member's ID number, so a
    // real export held a Harel and a Menora pension with the same "account
    // number". Matching on that alone merged them and overwrote one balance.
    const ctx = await fixture();
    const pensions: AgamLiderimAccount[] = [
      account({
        policyNumber: "212159024",
        provider: 'הראל פנסיה וגמל בע"מ',
        productType: "קרן פנסיה מקיפה",
        productName: "הראל פנסיה",
        balance: "101349",
      }),
      account({
        policyNumber: "212159024",
        provider: 'מנורה מבטחים פנסיה וגמל בע"מ',
        productType: "קרן פנסיה כללית",
        productName: "מנורה מבטחים משלימה",
        balance: "2225",
      }),
      // Same provider and ID, a different product: still its own account.
      account({
        policyNumber: "212159024",
        provider: 'הראל פנסיה וגמל בע"מ',
        productType: "קרן פנסיה כללית",
        productName: "הראל פנסיה משלימה",
        balance: "500",
      }),
    ];
    for (let i = 0; i < 2; i++) {
      // Twice: the second import must match all three, not create or merge.
      const syncRunId = await startRun(ctx.userId, ctx.connectionId);
      const result = await promoteAgamLiderimPortfolio({
        userId: ctx.userId,
        connectionId: ctx.connectionId,
        syncRunId,
        dataKey: ctx.dataKey,
        parserId: "agam_liderim_portfolio",
        parserVersion: 1,
        accounts: pensions,
      });
      expect(result.accountsCreated).toBe(i === 0 ? 3 : 0);
    }

    const accounts = await listLongTermSavingsAccounts(ctx.session);
    expect(accounts).toHaveLength(3);
    expect(accounts.map((a) => a.currentBalance?.amount).sort()).toEqual(["101349", "2225", "500"]);
  });

  it("matches the same account when a later export re-spells or renames its labels", async () => {
    // A provider rebrand or a re-spelled label must not mint a second account —
    // both would stay in net worth and double-count the same savings.
    const ctx = await fixture();
    const imports: AgamLiderimAccount[][] = [
      [
        account({ policyNumber: "212159024", provider: 'הראל פנסיה וגמל בע"מ', balance: "100" }),
        account({
          policyNumber: "212159024",
          provider: 'מנורה מבטחים פנסיה וגמל בע"מ',
          productType: "קרן פנסיה כללית",
          balance: "200",
        }),
      ],
      // Punctuation, spacing and the legal suffix changed: an exact match.
      [
        account({ policyNumber: "212159024", provider: "הראל  פנסיה וגמל", balance: "110" }),
        account({
          policyNumber: "212159024",
          provider: "מנורה מבטחים פנסיה וגמל בעמ",
          productType: 'קרן פנסיה "כללית"',
          balance: "210",
        }),
      ],
      // Menora rebranded outright: the one unpaired row takes the one unpaired account.
      [
        account({ policyNumber: "212159024", provider: 'הראל פנסיה וגמל בע"מ', balance: "120" }),
        account({
          policyNumber: "212159024",
          provider: 'מבטחים החדשה בע"מ',
          productType: "קרן פנסיה כללית",
          balance: "220",
        }),
      ],
    ];
    for (const [n, portfolio] of imports.entries()) {
      const syncRunId = await startRun(ctx.userId, ctx.connectionId);
      await promoteAgamLiderimPortfolio({
        userId: ctx.userId,
        connectionId: ctx.connectionId,
        syncRunId,
        dataKey: ctx.dataKey,
        parserId: "agam_liderim_portfolio",
        parserVersion: 1,
        // Each export is newer, so each moves the cached balance.
        accounts: portfolio.map((a) => ({ ...a, asOf: `2026-0${7 + n}-28` })),
      });
    }

    const accounts = await listLongTermSavingsAccounts(ctx.session);
    expect(accounts).toHaveLength(2);
    expect(accounts.map((a) => [a.institution, a.currentBalance?.amount]).sort()).toEqual([
      ['הראל פנסיה וגמל בע"מ', "120"],
      ['מבטחים החדשה בע"מ', "220"],
    ]);
  });

  it("heals an account imported under the old policy-number-only key", async () => {
    // Before the fix, the Menora row matched the Harel account by the shared ID
    // and overwrote its balance. Re-importing must reuse (and correct) that
    // account, and create the missing Menora one.
    const ctx = await fixture();
    const legacyId = randomUUID();
    await withUser(ctx.userId, async (tx) => {
      await tx.insert(schema.accounts).values({
        id: legacyId,
        ownerId: ctx.userId,
        accountType: "long_term_savings",
        classification: "asset",
        connectionId: ctx.connectionId,
        nameCt: encText(ctx.dataKey, "הראל פנסיה", legacyId, "name_ct", 1),
        institution: 'הראל פנסיה וגמל בע"מ',
        externalAccountRefCt: encText(
          ctx.dataKey,
          "212159024",
          legacyId,
          "external_account_ref_ct",
          1,
        ),
        currency: "ILS",
        status: "active",
        currentBalanceCt: encText(ctx.dataKey, "2225", legacyId, "current_balance_ct", 1),
      });
      await tx.insert(schema.longTermSavingsDetails).values({
        accountId: legacyId,
        ownerId: ctx.userId,
        product: "pension",
        liquidity: "locked_retirement",
        liquidFrom: null,
      });
    });

    const syncRunId = await startRun(ctx.userId, ctx.connectionId);
    const result = await promoteAgamLiderimPortfolio({
      userId: ctx.userId,
      connectionId: ctx.connectionId,
      syncRunId,
      dataKey: ctx.dataKey,
      parserId: "agam_liderim_portfolio",
      parserVersion: 1,
      accounts: [
        account({
          policyNumber: "212159024",
          provider: 'הראל פנסיה וגמל בע"מ',
          productName: "הראל פנסיה",
          balance: "101349",
        }),
        account({
          policyNumber: "212159024",
          provider: 'מנורה מבטחים פנסיה וגמל בע"מ',
          productType: "קרן פנסיה כללית",
          productName: "מנורה מבטחים משלימה",
          balance: "2225",
        }),
      ],
    });
    expect(result.accountsCreated).toBe(1);

    const accounts = await listLongTermSavingsAccounts(ctx.session);
    expect(accounts).toHaveLength(2);
    const harel = accounts.find((a) => a.accountId === legacyId)!;
    expect(harel.currentBalance?.amount).toBe("101349");
    const menora = accounts.find((a) => a.accountId !== legacyId)!;
    expect(menora.institution).toBe('מנורה מבטחים פנסיה וגמל בע"מ');
    expect(menora.currentBalance?.amount).toBe("2225");
  });

  it("fails an empty portfolio, writing nothing and marking the run failed", async () => {
    const ctx = await fixture();
    const syncRunId = await startRun(ctx.userId, ctx.connectionId);
    await expect(
      promoteAgamLiderimPortfolio({
        userId: ctx.userId,
        connectionId: ctx.connectionId,
        syncRunId,
        dataKey: ctx.dataKey,
        parserId: "agam_liderim_portfolio",
        parserVersion: 1,
        accounts: [],
      }),
    ).rejects.toBeInstanceOf(AgamLiderimPromotionError);

    const accountRows = await withUser(ctx.userId, (tx) => tx.select().from(schema.accounts));
    expect(accountRows).toHaveLength(0);
    const [run] = await withUser(ctx.userId, (tx) =>
      tx.select().from(schema.syncRuns).where(eq(schema.syncRuns.id, syncRunId)),
    );
    expect(run.status).toBe("failed");
    expect(run.error).toBe("empty_portfolio");
  });
});
