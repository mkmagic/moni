import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Money } from "@/components/money";
import { cn } from "@/lib/utils";
import type { EntryView } from "@/domain/transactions";

interface TransactionsTableProps {
  entries: EntryView[];
}

const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

export function TransactionsTable({ entries }: TransactionsTableProps) {
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-5 py-3 font-medium">Date</th>
            <th className="px-5 py-3 font-medium">Account</th>
            <th className="px-5 py-3 font-medium">Category</th>
            <th className="px-5 py-3 font-medium">Payee</th>
            <th className="px-5 py-3 text-right font-medium">Amount</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {entries.map((entry) => (
            <tr key={entry.id} className={cn(entry.excluded && "opacity-50")}>
              <td className="whitespace-nowrap px-5 py-3 tabular-nums text-muted-foreground">
                {DATE_FORMAT.format(new Date(entry.date))}
              </td>
              <td className="px-5 py-3 text-foreground">{entry.accountName}</td>
              <td className="px-5 py-3">
                {entry.categoryName ? (
                  <Badge>{entry.categoryName}</Badge>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </td>
              <td className="px-5 py-3 text-foreground">
                {entry.merchantName ?? entry.description}
                {entry.excluded && <Badge className="ml-2">transfer</Badge>}
              </td>
              <td className="whitespace-nowrap px-5 py-3 text-right">
                <Money value={entry.amount} signColor />
                {entry.fxPending && <Badge className="ml-2">pending FX</Badge>}
              </td>
            </tr>
          ))}
          {entries.length === 0 && (
            <tr>
              <td colSpan={5} className="px-5 py-8 text-center text-muted-foreground">
                No transactions yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Card>
  );
}
