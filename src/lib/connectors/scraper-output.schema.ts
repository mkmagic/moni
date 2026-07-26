// Zod schema for israeli-bank-scrapers' real return shape
// (`ScraperScrapingResult` / `TransactionsAccount` / `Transaction`) — this is
// the actual untrusted-input trust boundary (docs/design/conventions.md:
// "Zod at every trust boundary... scraper output"). scrape-worker.mts parses
// the raw result through this before any of it reaches the domain layer.
//
// Shape verified against the installed package's type declarations, not
// guessed:
//   node_modules/israeli-bank-scrapers/lib/scrapers/interface.d.ts (ScraperScrapingResult)
//   node_modules/israeli-bank-scrapers/lib/transactions.d.ts (TransactionsAccount, Transaction)
import { z } from "zod";

export const scraperTransactionSchema = z.object({
  type: z.enum(["normal", "installments"]),
  /** Sometimes called "Asmachta" — a provider reference. Some connectors omit it. */
  identifier: z.union([z.string(), z.number()]).optional(),
  /** ISO date string — the purchase date. This is the date used for
   * `import_key` (never `processedDate` — data-model.md §5/§6). */
  date: z.string(),
  /** ISO date string — when the bank posted/settled it. Mutates
   * pending -> posted; deliberately excluded from `import_key`. */
  processedDate: z.string(),
  originalAmount: z.number(),
  originalCurrency: z.string(),
  chargedAmount: z.number(),
  chargedCurrency: z.string().optional(),
  description: z.string(),
  memo: z.string().optional(),
  status: z.enum(["completed", "pending"]),
  installments: z
    .object({
      number: z.number(),
      total: z.number(),
    })
    .optional(),
});

export const scraperAccountSchema = z.object({
  accountNumber: z.string(),
  balance: z.number().optional(),
  balanceDate: z.string().optional(),
  currency: z.string().optional(),
  savingsAccount: z.boolean().optional(),
  txns: z.array(scraperTransactionSchema),
});

export const scraperScrapingResultSchema = z.object({
  success: z.boolean(),
  accounts: z.array(scraperAccountSchema).optional(),
  errorType: z.string().optional(),
  errorMessage: z.string().optional(),
});

export type ScraperTransaction = z.infer<typeof scraperTransactionSchema>;
export type ScraperAccount = z.infer<typeof scraperAccountSchema>;
export type ScraperScrapingResultParsed = z.infer<typeof scraperScrapingResultSchema>;
