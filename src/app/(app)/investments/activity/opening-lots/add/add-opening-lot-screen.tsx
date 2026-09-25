"use client";

import Decimal from "decimal.js";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";

import { Money } from "@/components/money";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { InvestmentResolutionItemView } from "@/domain/investment-activity-resolution";
import type { OpeningLotFormOption } from "@/domain/investment-opening-lots";

const selectClass =
  "w-full rounded-[var(--radius)] border border-input bg-background px-3 py-2 text-base text-foreground focus:outline-none focus:ring-2 focus:ring-ring sm:text-sm";

export function AddOpeningLotScreen({
  options,
  origin,
  initialAccountId,
  initialInstrumentId,
}: {
  options: OpeningLotFormOption[];
  origin: InvestmentResolutionItemView | null;
  initialAccountId: string | null;
  initialInstrumentId: string | null;
}) {
  const fallbackAccount = options[0]?.accountId ?? "";
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [accountId, setAccountId] = useState(initialAccountId ?? fallbackAccount);
  const account = options.find((item) => item.accountId === accountId);
  const fallbackInstrument = account?.instruments[0]?.id ?? "";
  const [instrumentId, setInstrumentId] = useState(initialInstrumentId ?? fallbackInstrument);
  const instrument = account?.instruments.find((item) => item.id === instrumentId);
  const [tradeDate, setTradeDate] = useState("");
  const [quantity, setQuantity] = useState(origin?.gap?.openingQuantity ?? "");
  const [remainingQuantity, setRemainingQuantity] = useState(origin?.gap?.openingQuantity ?? "");
  const [unitCost, setUnitCost] = useState("");
  const [totalCost, setTotalCost] = useState("");
  const [fee, setFee] = useState("");
  const [ilsFxRate, setIlsFxRate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currency = instrument?.currency ?? account?.currency ?? "ILS";
  let valid = Boolean(accountId && instrumentId && /^\d{4}-\d{2}-\d{2}$/.test(tradeDate));
  try {
    valid =
      valid &&
      new Decimal(quantity).isPositive() &&
      new Decimal(remainingQuantity).isPositive() &&
      new Decimal(remainingQuantity).lte(quantity) &&
      new Decimal(totalCost).isPositive() &&
      (!unitCost || new Decimal(unitCost).isPositive()) &&
      (!fee || new Decimal(fee).gte(0)) &&
      (!ilsFxRate || new Decimal(ilsFxRate).isPositive());
  } catch {
    valid = false;
  }

  async function commit() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/investments/activity/opening-lots", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId,
          instrumentId,
          tradeDate,
          quantity,
          remainingQuantity,
          unitCost: unitCost || undefined,
          totalCost,
          currency,
          fee: fee || undefined,
          ilsFxRate: ilsFxRate || undefined,
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? "The opening lot could not be added.");
      }
      window.location.assign("/investments/activity?added=1#opening-lots");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The opening lot could not be added.");
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      <Link
        href="/investments/activity"
        className="mb-4 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Activity & lots
      </Link>
      <Card className="space-y-6 p-6 pt-7">
        <div>
          <h2 className="text-xl font-semibold">Add one opening lot</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Nothing is written until you confirm the reviewed lot.
          </p>
        </div>
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Step {step} of 3 · {step === 1 ? "Understand" : step === 2 ? "Choose" : "Review"}
        </p>
        {step === 1 && (
          <div className="space-y-4 text-sm">
            <p>
              An opening lot records an investment you already owned before Moni had trustworthy
              activity history. It is evidence, not an invented trade.
            </p>
            {origin?.gap && (
              <div className="rounded-[var(--radius)] border border-primary/30 p-4">
                <p className="font-medium">History gap: {origin.instrumentLabel}</p>
                <p className="mt-1 text-muted-foreground">
                  The broker snapshot exceeds the activity-derived quantity by{" "}
                  <span className="tabular-nums">{origin.gap.openingQuantity}</span>. Account,
                  investment, and remaining quantity are prefilled below.
                </p>
              </div>
            )}
          </div>
        )}
        {step === 2 && (
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">Account</span>
              <select
                className={selectClass}
                value={accountId}
                disabled={Boolean(origin)}
                onChange={(event) => {
                  const next = event.target.value;
                  setAccountId(next);
                  setInstrumentId(
                    options.find((item) => item.accountId === next)?.instruments[0]?.id ?? "",
                  );
                }}
              >
                {options.map((item) => (
                  <option key={item.accountId} value={item.accountId}>
                    {item.accountName}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">Investment</span>
              <select
                className={selectClass}
                value={instrumentId}
                disabled={Boolean(origin)}
                onChange={(event) => setInstrumentId(event.target.value)}
              >
                {account?.instruments.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">Acquisition date</span>
              <Input
                type="date"
                value={tradeDate}
                onChange={(event) => setTradeDate(event.target.value)}
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">Currency</span>
              <Input value={currency} disabled className="tabular-nums" />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">Original quantity</span>
              <Input
                inputMode="decimal"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                className="tabular-nums"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">Remaining quantity</span>
              <Input
                inputMode="decimal"
                value={remainingQuantity}
                onChange={(event) => setRemainingQuantity(event.target.value)}
                className="tabular-nums"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">Unit cost · optional</span>
              <Input
                inputMode="decimal"
                value={unitCost}
                onChange={(event) => setUnitCost(event.target.value)}
                className="tabular-nums"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">Total cost</span>
              <Input
                inputMode="decimal"
                value={totalCost}
                onChange={(event) => setTotalCost(event.target.value)}
                className="tabular-nums"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">Fee · optional</span>
              <Input
                inputMode="decimal"
                value={fee}
                onChange={(event) => setFee(event.target.value)}
                className="tabular-nums"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">ILS FX rate · optional</span>
              <Input
                inputMode="decimal"
                value={ilsFxRate}
                onChange={(event) => setIlsFxRate(event.target.value)}
                className="tabular-nums"
              />
            </label>
          </div>
        )}
        {step === 3 && (
          <div className="grid gap-4 rounded-[var(--radius)] border border-border p-4 text-sm sm:grid-cols-2">
            <div>
              <p className="text-xs text-muted-foreground">Account · investment</p>
              <p>
                {account?.accountName} · {instrument?.label}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Acquired</p>
              <p className="tabular-nums">{tradeDate}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Original / remaining quantity</p>
              <p className="tabular-nums">
                {quantity} / {remainingQuantity}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Native total cost</p>
              <Money value={{ amount: totalCost, currency }} />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Fee</p>
              {fee ? <Money value={{ amount: fee, currency }} /> : <p>None</p>}
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Locked ILS FX</p>
              <p className="tabular-nums">
                {ilsFxRate || "Bank of Israel lookup on acquisition date"}
              </p>
            </div>
          </div>
        )}
        {error && <p className="text-sm text-negative">{error}</p>}
        <div className="flex items-center justify-between border-t border-border pt-4">
          {step === 1 ? (
            <Link
              href="/investments/activity"
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              Back to activity
            </Link>
          ) : (
            <Button variant="ghost" onClick={() => setStep(step === 3 ? 2 : 1)} disabled={busy}>
              Back
            </Button>
          )}
          {step === 1 ? (
            <Button onClick={() => setStep(2)} disabled={!options.length}>
              Enter lot details
            </Button>
          ) : step === 2 ? (
            <Button onClick={() => setStep(3)} disabled={!valid}>
              Review opening lot
            </Button>
          ) : (
            <Button onClick={() => void commit()} disabled={!valid || busy}>
              Add opening lot
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}
