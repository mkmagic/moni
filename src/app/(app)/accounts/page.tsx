import { requireSession } from "@/domain/auth";
import { requireOnboarded } from "@/domain/onboarding";
import {
  listAccountsGrouped,
  type AccountGroupKey,
  type AccountGroupView,
} from "@/domain/accounts";
import { listLongTermSavingsSummaries } from "@/domain/long-term-savings";
import { AccountCard } from "@/components/account-card";
import { Money } from "@/components/money";
import type { AccountView } from "@/domain/accounts";

// Ordered most-accessible to least, so the page reads as a story rather than a
// taxonomy. Cash merges checking and savings: both are money you can move
// today (#77 §1).
const GROUP_LABELS: Record<AccountGroupKey, string> = {
  cash: "Cash",
  investments: "Investments",
  long_term_savings: "Long-term savings",
  other: "Other",
};

export default async function AccountsPage() {
  const session = await requireSession();
  await requireOnboarded(session.userId);
  const [grouped, savings] = await Promise.all([
    listAccountsGrouped(session),
    listLongTermSavingsSummaries(session),
  ]);
  const valuationFor = (id: string) => {
    const amount = grouped.investmentValues.get(id);
    // Base currency: an investment account's holdings span currencies, so its
    // one comparable number is the ILS total, same as the dashboard's.
    return amount === undefined ? undefined : { amount, currency: "ILS" };
  };

  const cards = (list: AccountView[]) => (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {list.map((account) => (
        <AccountCard
          key={account.id}
          account={account}
          valuation={valuationFor(account.id)}
          savings={savings.get(account.id)}
        />
      ))}
    </div>
  );

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Accounts</h1>
        <p className="text-sm text-muted-foreground">Every account connected to Moni</p>
      </div>

      {grouped.assetGroups.length > 0 && (
        <section className="flex flex-col gap-6">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Assets
          </h2>
          {grouped.assetGroups.map((group) => (
            <div key={group.key} className="flex flex-col gap-3">
              <GroupHeading group={group} />
              {cards(group.accounts)}
            </div>
          ))}
        </section>
      )}

      {grouped.liabilities.length > 0 && (
        <section className="flex flex-col gap-4">
          {/* Liabilities stay flat — most households have one or two, and a
              heading per type would outnumber the cards beneath it. */}
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Liabilities
          </h2>
          {cards(grouped.liabilities)}
        </section>
      )}

      {grouped.assetGroups.length === 0 && grouped.liabilities.length === 0 && (
        <p className="text-sm text-muted-foreground">No accounts connected yet.</p>
      )}
    </div>
  );
}

function GroupHeading({ group }: { group: AccountGroupView }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-2">
      <h3 className="text-sm font-medium text-foreground">{GROUP_LABELS[group.key]}</h3>
      <div className="flex items-baseline gap-2">
        {group.unvaluedCount > 0 && (
          // A subtotal smaller than the cards above it has to say why: an
          // account with no balance, or no recent enough rate to value one.
          <span className="text-xs text-muted-foreground">
            {group.unvaluedCount === 1
              ? "1 account not valued"
              : `${group.unvaluedCount} accounts not valued`}
          </span>
        )}
        <Money value={group.subtotal} className="text-sm font-semibold text-foreground" />
      </div>
    </div>
  );
}
