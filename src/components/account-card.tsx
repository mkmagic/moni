import Link from "next/link";
import { Landmark, CreditCard, TrendingUp, Wallet } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Money } from "@/components/money";
import { getConnectorDefinition, institutionDisplayName } from "@/lib/connectors";
import type { Money as MoneyValue } from "@/lib/money";
import type { AccountView } from "@/domain/accounts";

interface AccountCardProps {
  account: AccountView;
  /**
   * Current worth in ILS for an investment account, whose value comes from its
   * holdings rather than a stored balance. Absent for every other account type.
   */
  valuation?: MoneyValue;
}

const ACCOUNT_ICONS: Record<string, LucideIcon> = {
  checking: Landmark,
  savings: Landmark,
  credit_card: CreditCard,
  investment: TrendingUp,
};

export function AccountCard({ account, valuation }: AccountCardProps) {
  const Icon = ACCOUNT_ICONS[account.accountType] ?? Wallet;
  const accentClass = account.classification === "asset" ? "text-positive" : "text-negative";
  const value = valuation ?? account.balance;
  // An investment account's detail view is the Investments screen; nothing
  // else has one yet, so nothing else gets the clickable glow (ui-and-feel.md
  // §6 — the glow means "this navigates", not "this is important").
  const href = account.accountType === "investment" ? "/investments" : null;
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
  // once its payload has been synced.
  const provenance = [
    title === source ? null : `via ${source}`,
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
