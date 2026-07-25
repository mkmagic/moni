import { Landmark, CreditCard, TrendingUp, Wallet } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Money } from "@/components/money";
import type { AccountView } from "@/domain/accounts";

interface AccountCardProps {
  account: AccountView;
}

const ACCOUNT_ICONS: Record<string, LucideIcon> = {
  checking: Landmark,
  savings: Landmark,
  credit_card: CreditCard,
  investment: TrendingUp,
};

export function AccountCard({ account }: AccountCardProps) {
  const Icon = ACCOUNT_ICONS[account.accountType] ?? Wallet;
  const accentClass = account.classification === "asset" ? "text-positive" : "text-negative";

  return (
    <Card>
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
          <span className="font-semibold text-foreground">{account.name}</span>
          <span className="text-xs text-muted-foreground">
            {account.institution ?? "Manual account"}
            {account.last4 && ` •••• ${account.last4}`}
          </span>
        </div>
        {account.balance ? (
          <Money value={account.balance} className={`text-xl font-bold ${accentClass}`} />
        ) : (
          <span className="text-sm text-muted-foreground">Balance unavailable</span>
        )}
      </CardContent>
    </Card>
  );
}
