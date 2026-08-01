-- sync_runs.investment_source is a plain `text` column guarded by a CHECK, not
-- the investment_source enum 0018 extended, so adding the enum value alone left
-- every SnapTrade run failing at the final status update.
ALTER TABLE "sync_runs" DROP CONSTRAINT IF EXISTS "sync_runs_investment_source_check";--> statement-breakpoint
ALTER TABLE "sync_runs"
  ADD CONSTRAINT "sync_runs_investment_source_check"
  CHECK ("investment_source" IS NULL OR "investment_source" IN ('ibkr_flex', 'schwab_positions_csv', 'snaptrade'));
