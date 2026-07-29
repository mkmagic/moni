// Domain write: merchant resolution — the writer `merchants` never had
// (docs/adr/0005-*).
//
// A merchant is a match text that got promoted to a row, so a name, an icon
// and a cadence override have somewhere to live. Two layers run here: the
// shipped catalog names the payees we know, and everything else is named
// after its own match text. The third layer, external lookup, is #12's.
//
// Identity is the catalog key when the catalog matches, and the match text
// when it doesn't. That is what makes `PAYPAL *NETFLIX` and `NETFLIX` one
// Netflix instead of two rows with the same name.
//
// Dedupe happens here rather than in Postgres because `match_text_ct` is
// Tier-1 and ciphertext is randomized: two rows for one payee do not look
// equal to a unique constraint. Same shape as `category_rejections`.
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { withUser } from "@/db/client";
import { entries, merchants } from "@/db/schema";
import { normalizeDescription } from "@/lib/categorization/normalize";
import { matchCatalog } from "@/lib/merchants/catalog";
import type { Session } from "@/lib/auth/session-store";
import { decText, encText } from "./fields";

/** Same shape sync-promotion.ts and categorization.ts use for a transaction handle. */
type Tx = Parameters<Parameters<typeof withUser>[1]>[0];

export interface MerchantResolutionSummary {
  merchantsCreated: number;
  entriesLinked: number;
}

/**
 * What makes two payees the same payee. The catalog key when there is one —
 * so every spelling of Netflix lands on one merchant — otherwise the match
 * text itself.
 */
function identityOf(matchText: string): string {
  return matchCatalog(matchText)?.key ?? matchText;
}

/**
 * Resolves a merchant for each of `entryIds` that has none yet, creating
 * merchant rows as needed. Runs inside the caller's transaction so a
 * rolled-back scrape leaves no merchants behind either.
 *
 * Entries whose description normalizes to nothing are skipped: an empty match
 * text is not a payee, and it would otherwise collect every unnamed
 * transaction into one meaningless merchant.
 */
export async function resolveMerchants(
  tx: Tx,
  ownerId: string,
  dataKey: Uint8Array,
  entryIds: string[],
): Promise<MerchantResolutionSummary> {
  const summary: MerchantResolutionSummary = { merchantsCreated: 0, entriesLinked: 0 };
  if (entryIds.length === 0) return summary;

  const rows = await tx
    .select({
      id: entries.id,
      descriptionCt: entries.descriptionCt,
      merchantId: entries.merchantId,
      version: entries.version,
    })
    .from(entries)
    .where(and(inArray(entries.id, entryIds), isNull(entries.merchantId)));
  if (rows.length === 0) return summary;

  // Decrypt the existing merchants once and index them by identity — the
  // in-memory stand-in for the unique constraint we cannot have.
  const existing = await tx
    .select({ id: merchants.id, matchTextCt: merchants.matchTextCt, version: merchants.version })
    .from(merchants);
  const byIdentity = new Map<string, string>();
  for (const m of existing) {
    const matchText = decText(dataKey, m.matchTextCt, m.id, "match_text_ct", m.version);
    if (matchText === null) continue;
    byIdentity.set(identityOf(matchText), m.id);
  }

  for (const row of rows) {
    const description = decText(dataKey, row.descriptionCt, row.id, "description_ct", row.version);
    if (description === null) continue;
    const matchText = normalizeDescription(description);
    if (matchText === "") continue;

    const identity = identityOf(matchText);
    let merchantId = byIdentity.get(identity);

    if (!merchantId) {
      const entry = matchCatalog(matchText);
      merchantId = randomUUID();
      await tx.insert(merchants).values({
        id: merchantId,
        ownerId,
        nameCt: encText(dataKey, entry?.name ?? matchText, merchantId, "name_ct", 1),
        matchTextCt: encText(dataKey, matchText, merchantId, "match_text_ct", 1),
        // Origin-local or null, never an external URL (docs/adr/0007-*).
        logoUrl: entry?.logoPath ?? null,
        source: entry ? "catalog" : "match_text",
      });
      byIdentity.set(identity, merchantId);
      summary.merchantsCreated++;
    }

    await tx.update(entries).set({ merchantId }).where(eq(entries.id, row.id));
    summary.entriesLinked++;
  }

  return summary;
}

/**
 * Sets (or clears, with null) a payee's cadence override — the escape hatch
 * for the case no amount of cleverness fixes: an annual subscription with one
 * payment so far has no gap to read (docs/adr/0006-*).
 *
 * Keyed by match text rather than merchant id because the recurring view
 * groups payees derived from descriptions, so a row can exist for history
 * scraped before merchant resolution did. When no merchant row backs the row
 * yet, this creates one — which is the only moment the user needs it to exist.
 */
export async function setMerchantCadence(
  session: Session,
  matchText: string,
  cadence: string | null,
): Promise<void> {
  const { userId, dataKey } = session;
  const identity = identityOf(matchText);

  await withUser(userId, async (tx) => {
    const rows = await tx.select().from(merchants);
    for (const m of rows) {
      const mt = decText(dataKey, m.matchTextCt, m.id, "match_text_ct", m.version);
      if (mt === null || identityOf(mt) !== identity) continue;
      await tx.update(merchants).set({ cadenceOverride: cadence }).where(eq(merchants.id, m.id));
      return;
    }

    const entry = matchCatalog(matchText);
    const id = randomUUID();
    await tx.insert(merchants).values({
      id,
      ownerId: userId,
      nameCt: encText(dataKey, entry?.name ?? matchText, id, "name_ct", 1),
      matchTextCt: encText(dataKey, matchText, id, "match_text_ct", 1),
      logoUrl: entry?.logoPath ?? null,
      source: entry ? "catalog" : "match_text",
      cadenceOverride: cadence,
    });
  });
}

/**
 * Resolves merchants for every entry that still has none — the one-time pass
 * over history already scraped before merchant resolution existed, and the
 * repair path if anything is ever missed. Safe to re-run: an entry that
 * already has a merchant is not reconsidered.
 */
export async function backfillMerchants(session: Session): Promise<MerchantResolutionSummary> {
  const { userId, dataKey } = session;
  return withUser(userId, async (tx) => {
    const pending = await tx
      .select({ id: entries.id })
      .from(entries)
      .where(isNull(entries.merchantId));
    return resolveMerchants(
      tx,
      userId,
      dataKey,
      pending.map((e) => e.id),
    );
  });
}
