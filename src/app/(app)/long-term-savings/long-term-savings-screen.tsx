"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  ChevronDown,
  ChevronRight,
  FileUp,
  Lock,
  LockOpen,
  PiggyBank,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ImportDialog } from "@/components/import-dialog";
import { Money } from "@/components/money";
import type { ConnectionView } from "@/domain/connections";
import type {
  LongTermSavingsAccountView,
  LongTermSavingsSnapshotView,
} from "@/domain/long-term-savings";
import { getConnectorDefinition } from "@/lib/connectors";
import {
  asOfLabel,
  dayLabel,
  forMonthLabel,
  formatPercent,
  liquidityBadge,
  statedPeriodLabel,
} from "@/lib/long-term-savings/labels";

/**
 * Pension, קרן השתלמות and קופת גמל, one card per account.
 *
 * Lead order per account is balance → flows for the stated period → fees. Fees
 * come last because they are the smallest number, and first in *consequence*
 * because they are the only one the member can act on — so the fee row is quiet
 * when there is nothing to do and promotes itself to a callout only when the
 * member pays above the fund average. An app that opens with a scolding number
 * every visit is an app people stop opening.
 */
export function LongTermSavingsScreen({
  accounts,
  connections,
}: {
  accounts: LongTermSavingsAccountView[];
  connections: ConnectionView[];
}) {
  const router = useRouter();
  const [importOpen, setImportOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const importConnections = connections.filter(
    (connection) =>
      connection.mode === "user_mediated_import" &&
      getConnectorDefinition(connection.connectorId)?.kind === "long_term_savings",
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Long-term savings</h1>
          {/* Each Hebrew term is its own isolate. Without them the two run
              together as one RTL paragraph and render in the wrong order —
              the stored text is fine, only the display reorders. */}
          <p className="text-sm text-muted-foreground">
            {"Your pension, "}
            <bdi>קרן השתלמות</bdi>
            {" and "}
            <bdi>קופת גמל</bdi>
            {", from the reports you import"}
          </p>
        </div>
        {/* Outline, not the amber primary: on this screen the accent belongs to
            a fee callout when one is showing, and it is the only thing here the
            member can act on. */}
        <Button
          type="button"
          variant="outline"
          className="gap-1.5"
          disabled={importConnections.length === 0}
          onClick={() => setImportOpen(true)}
        >
          <FileUp className="h-3.5 w-3.5" /> Import document
        </Button>
      </div>

      {notice && (
        <Card className="border-border px-5 py-3">
          <p className="text-sm text-foreground">{notice}</p>
        </Card>
      )}

      {accounts.length === 0 ? (
        <EmptyState canImport={importConnections.length > 0} onImport={() => setImportOpen(true)} />
      ) : (
        accounts.map((account) => <AccountPanel key={account.accountId} account={account} />)
      )}

      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        connections={importConnections}
        onDone={(message) => {
          setImportOpen(false);
          setNotice(message);
          router.refresh();
        }}
      />
    </div>
  );
}

function EmptyState({ canImport, onImport }: { canImport: boolean; onImport: () => void }) {
  return (
    <Card className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <PiggyBank className="h-8 w-8 text-muted-foreground" />
      <p className="text-sm font-medium text-foreground">No long-term savings imported yet</p>
      <p className="max-w-md text-sm text-muted-foreground">
        {
          "Providers publish a quarterly report as a PDF. Import one and its balance joins your net worth, with its deposits and fees kept alongside."
        }
      </p>
      {canImport ? (
        <Button type="button" className="gap-1.5" onClick={onImport}>
          <FileUp className="h-3.5 w-3.5" /> Import document
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">
          {"Add a provider under Settings › Connections first."}
        </p>
      )}
    </Card>
  );
}

function AccountPanel({ account }: { account: LongTermSavingsAccountView }) {
  const [open, setOpen] = useState<"deposits" | "tracks" | null>(null);
  const snapshot = account.latest;
  const liquidity = liquidityBadge({
    liquidity: account.liquidity,
    liquidFrom: account.liquidFrom,
    // The report's own retirement age, when one was imported.
    retirementAge: snapshot?.retirementAge ?? null,
  });
  const LiquidityIcon = liquidity.locked ? Lock : LockOpen;

  return (
    <Card className="flex flex-col gap-5 px-6 pb-6 pt-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-base font-semibold text-foreground">{account.name}</span>
          {account.institution && (
            <span className="text-xs text-muted-foreground">
              <bdi>{account.institution}</bdi>
            </span>
          )}
        </div>
        {snapshot && (
          <Money value={snapshot.closingBalance} className="text-2xl font-bold text-positive" />
        )}
      </div>

      {!snapshot ? (
        <p className="text-sm text-muted-foreground">No report imported for this account yet.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {asOfLabel({
                asOf: snapshot.asOf,
                quarter: snapshot.quarter,
                fiscalYear: snapshot.fiscalYear,
              })}
            </span>
            <span className="inline-flex items-center gap-1">
              <LiquidityIcon className="h-3 w-3" />
              {liquidity.text}
            </span>
          </div>

          <Flows snapshot={snapshot} />
          <Fees snapshot={snapshot} />

          <div className="flex flex-wrap gap-2">
            {snapshot.deposits.length > 0 && (
              <Disclosure
                label={`Deposits (${snapshot.deposits.length})`}
                open={open === "deposits"}
                onToggle={() => setOpen(open === "deposits" ? null : "deposits")}
              />
            )}
            {snapshot.tracks.length > 0 && (
              <Disclosure
                label={
                  snapshot.tracks.length === 1
                    ? `Track: ${snapshot.tracks[0].name}`
                    : `Tracks (${snapshot.tracks.length})`
                }
                open={open === "tracks"}
                onToggle={() => setOpen(open === "tracks" ? null : "tracks")}
              />
            )}
          </div>

          {open === "deposits" && <DepositTable snapshot={snapshot} />}
          {open === "tracks" && <TrackTable snapshot={snapshot} />}
        </>
      )}
    </Card>
  );
}

function Flows({ snapshot }: { snapshot: LongTermSavingsSnapshotView }) {
  // The period is the one the DOCUMENT states — year-to-date on an Israeli
  // quarterly report — so a Q3 figure is never labelled "this quarter" (#76 D6).
  const period = statedPeriodLabel(snapshot.statedPeriodStart, snapshot.statedPeriodEnd);
  return (
    <dl className="flex flex-col gap-1.5 text-sm">
      <FlowRow label="Contributed" period={period} value={snapshot.contributions} />
      <FlowRow label="Gains" period={period} value={snapshot.investmentResult} signColor />
      <FlowRow label="Fees charged" period={period} value={snapshot.feesCharged} />
    </dl>
  );
}

function FlowRow({
  label,
  period,
  value,
  signColor,
}: {
  label: string;
  period: string;
  value: { amount: string; currency: string };
  signColor?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="flex items-baseline gap-2">
        <span className="text-foreground">{label}</span>
        <span className="text-xs text-muted-foreground">{period}</span>
      </dt>
      <dd>
        <Money value={value} signColor={signColor} className="font-medium" />
      </dd>
    </div>
  );
}

function Fees({ snapshot }: { snapshot: LongTermSavingsSnapshotView }) {
  const { fees } = snapshot;
  const rates = [
    fees.onDeposit === null ? null : `${formatPercent(fees.onDeposit)} deposits`,
    fees.onSavings === null ? null : `${formatPercent(fees.onSavings)} savings`,
  ].filter((part): part is string => part !== null);
  if (rates.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span className="text-foreground">Fees</span>
        <span className="tabular-nums text-muted-foreground">{rates.join(" · ")}</span>
      </div>
      {fees.aboveAverage.length > 0 ? (
        // The one place this screen raises its voice. An extra 1% a year over a
        // career costs roughly a fifth of the final balance, and fees are
        // negotiable in Israel — so this is worth an accent, and nothing else
        // here is.
        <div className="flex items-start gap-2 rounded-[var(--radius)] border border-primary/40 px-3 py-2 text-sm">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div className="flex flex-col gap-0.5">
            {fees.aboveAverage.map((item) => (
              <p key={item.dimension} className="text-foreground">
                {`You pay ${formatPercent(item.rate)} on ${item.dimension}. The fund average is ${formatPercent(item.fundAverage)}.`}
              </p>
            ))}
          </div>
        </div>
      ) : (
        (fees.fundAverageOnDeposit !== null || fees.fundAverageOnSavings !== null) && (
          <p className="inline-flex items-center gap-1.5 text-xs text-positive">
            <Check className="h-3.5 w-3.5" /> below the fund average
          </p>
        )
      )}
    </div>
  );
}

function Disclosure({
  label,
  open,
  onToggle,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="inline-flex items-center gap-1 rounded-[var(--radius)] px-2 py-1 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
    >
      {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
      <bdi>{label}</bdi>
    </button>
  );
}

function DepositTable({ snapshot }: { snapshot: LongTermSavingsSnapshotView }) {
  const hasEmployer = snapshot.deposits.some((row) => row.employer !== null);
  const hasSalary = snapshot.deposits.some((row) => row.salary !== null);
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-0 text-xs">
        <thead>
          <tr className="text-left text-muted-foreground">
            <Th>Deposited</Th>
            <Th>For</Th>
            {hasEmployer && <Th>Employer</Th>}
            {hasSalary && <Th align="right">Salary</Th>}
            <Th align="right">Employee</Th>
            <Th align="right">Employer</Th>
            <Th align="right">Severance</Th>
            <Th align="right">Total</Th>
          </tr>
        </thead>
        <tbody>
          {snapshot.deposits.map((row) => (
            <tr key={row.rowIndex}>
              <Td>{dayLabel(row.depositDate)}</Td>
              <Td>{forMonthLabel(row.forMonth)}</Td>
              {hasEmployer && (
                <Td>
                  <bdi>{row.employer ?? "—"}</bdi>
                </Td>
              )}
              {hasSalary && (
                <Td align="right">{row.salary ? <Money value={row.salary} /> : "—"}</Td>
              )}
              <Td align="right">
                <Money value={row.employee} />
              </Td>
              <Td align="right">
                <Money value={row.employerContribution} />
              </Td>
              <Td align="right">
                <Money value={row.severance} />
              </Td>
              <Td align="right">
                <Money value={row.total} className="font-medium" />
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TrackTable({ snapshot }: { snapshot: LongTermSavingsSnapshotView }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-0 text-xs">
        <thead>
          <tr className="text-left text-muted-foreground">
            <Th>Track</Th>
            <Th align="right">Return</Th>
            <Th align="right">Expected annual cost</Th>
          </tr>
        </thead>
        <tbody>
          {snapshot.tracks.map((track) => (
            <tr key={track.rowIndex}>
              <Td>
                <bdi>{track.name}</bdi>
              </Td>
              <Td align="right">
                {track.returnPercent === null ? "—" : formatPercent(track.returnPercent)}
              </Td>
              <Td align="right">
                {track.annualCostPercent === null ? "—" : formatPercent(track.annualCostPercent)}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: "right" }) {
  return (
    <th
      className={`border-b border-border px-2 py-1.5 font-medium ${align === "right" ? "text-right" : ""}`}
    >
      {children}
    </th>
  );
}

function Td({ children, align }: { children: React.ReactNode; align?: "right" }) {
  return (
    <td
      className={`border-b border-border px-2 py-1.5 tabular-nums text-foreground ${align === "right" ? "text-right" : ""}`}
    >
      {children}
    </td>
  );
}
