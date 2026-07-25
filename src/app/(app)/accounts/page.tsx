import { requireSession } from "@/domain/auth";
import { listAccounts } from "@/domain/accounts";
import { AccountCard } from "@/components/account-card";

export default async function AccountsPage() {
  const session = await requireSession();
  const accounts = await listAccounts(session);
  const assets = accounts.filter((a) => a.classification === "asset");
  const liabilities = accounts.filter((a) => a.classification === "liability");

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Accounts</h1>
        <p className="text-sm text-muted-foreground">Every account connected to Moni</p>
      </div>

      {assets.length > 0 && (
        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Assets
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {assets.map((account) => (
              <AccountCard key={account.id} account={account} />
            ))}
          </div>
        </section>
      )}

      {liabilities.length > 0 && (
        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Liabilities
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {liabilities.map((account) => (
              <AccountCard key={account.id} account={account} />
            ))}
          </div>
        </section>
      )}

      {accounts.length === 0 && (
        <p className="text-sm text-muted-foreground">No accounts connected yet.</p>
      )}
    </div>
  );
}
