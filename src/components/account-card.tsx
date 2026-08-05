import Link from "next/link";
import { Landmark, CreditCard, Lock, LockOpen, PiggyBank, TrendingUp, Wallet } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Money } from "@/components/money";
import { getConnectorDefinition, institutionDisplayName } from "@/lib/connectors";
import { asOfLabel, liquidityBadge } from "@/lib/long-term-savings/labels";
import type { Money as MoneyValue } from "@/lib/money";
import type { AccountView } from "@/domain/accounts";
import type { LongTermSavingsSummary } from "@/domain/long-term-savings";

interface AccountCardProps {
  account: AccountView;
  /**
   * Current worth in ILS for an investment account, whose value comes from its
   * holdings rather than a stored balance. Absent for every other account type.
   */
  valuation?: MoneyValue;
  /**
   * Present only for a `long_term_savings` account. Carries the two facts the
   * balance alone doesn't say: that the money isn't spendable, and that the
   * figure is as old as the last quarterly report.
   */
  savings?: LongTermSavingsSummary;
}

const ACCOUNT_ICONS: Record<string, LucideIcon> = {
  checking: Landmark,
  savings: Landmark,
  credit_card: CreditCard,
  investment: TrendingUp,
  long_term_savings: PiggyBank,
};

const DETAIL_VIEWS: Record<string, string> = {
  investment: "/investments",
  long_term_savings: "/long-term-savings",
};

export function AccountCard({ account, valuation, savings }: AccountCardProps) {
  const Icon = ACCOUNT_ICONS[account.accountType] ?? Wallet;
  const accentClass = account.classification === "asset" ? "text-positive" : "text-negative";
  const value = valuation ?? account.balance;
  // Only an account type with a detail view gets the clickable glow
  // (ui-and-feel.md §6 — the glow means "this navigates", not "this is
  // important"). There is still no `/accounts/[id]`, and this doesn't add one.
  const href = DETAIL_VIEWS[account.accountType] ?? null;
  const liquidity = savings ? liquidityBadge(savings) : null;
  const LiquidityIcon = liquidity?.locked ? Lock : LockOpen;
  // How Moni reaches the account, kept visibly distinct from the account
  // itself: an aggregator is not the brokerage the money is actually at.
  const connector = account.connectorId ? getConnectorDefinition(account.connectorId) : undefined;
  const source = connector ? connector.label : (account.institution ?? "Manual account");
  // An investment account's stored name is one Moni derived itself
  // (`${institution} (${last4})`), so re-deriving it here is not overriding
  // anything a user or a bank chose — and it corrects rows named before the
  // real brokerage was known, without waiting for the next sync. Every other
  // account type keeps the name its source gave it.
  const title =
    (account.accountType === "investment"
      ? institutionDisplayName(account.institution, account.connectorId)
      : null) ?? account.name;
  // "SnapTrade / via SnapTrade" says one thing twice. That happens whenever
  // the connector is all Moni knows — an aggregator only names the brokerage
  // once its payload has been synced. `includes`, not equality: a long-term
  // savings account is named "<provider> <document>", so it CONTAINS the
  // connector's own label ("Harel Quarterly Pension Report / via Quarterly
  // Pension Report") without ever equalling it.
  const provenance = [
    title.includes(source) ? null : `via ${source}`,
    account.last4 && `•••• ${account.last4}`,
  ]
    .filter(Boolean)
    .join(" · ");

  const card = (
    <Card className={href ? "card-glow relative h-full overflow-hidden" : undefined}>
      {href && (
        <span
          aria-hidden
          className="card-glow-top pointer-events-none absolute inset-x-0 top-0 h-px"
        />
      )}
      <CardContent className="flex flex-col gap-4 px-5 pb-5 pt-6">
        <div className="flex items-center justify-between">
          <div className="flex h-8 w-8 items-center justify-center rounded-[var(--radius)] bg-muted text-muted-foreground">
            <Icon className="h-4 w-4" />
          </div>
          {account.currency !== "ILS" && (
            <span className="text-xs text-muted-foreground">{account.currency}</span>
          )}
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="font-semibold text-foreground">{title}</span>
          <span className="text-xs text-muted-foreground">{provenance}</span>
        </div>
        {value ? (
          <Money value={value} className={`text-xl font-bold ${accentClass}`} />
        ) : (
          <span className="text-sm text-muted-foreground">Balance unavailable</span>
        )}
        {liquidity && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <LiquidityIcon className="h-3 w-3" />
              {liquidity.text}
            </span>
            {savings?.asOf && (
              <span className="tabular-nums">
                {`· ${asOfLabel({ asOf: savings.asOf, quarter: savings.quarter, fiscalYear: savings.fiscalYear })}`}
              </span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );

  return href ? (
    <Link href={href} className="card-link">
      {card}
    </Link>
  ) : (
    card
  );
}
