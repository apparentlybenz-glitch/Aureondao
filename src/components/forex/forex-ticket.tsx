"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowDown, ArrowLeftRight, ArrowUp } from "lucide-react";
import { useTranslations } from "next-intl";
import { ForexIcon } from "@/components/forex/forex-icon";
import { DrawnCheck } from "@/components/app/drawn-check";
import { useRpcMessage } from "@/components/app/use-rpc-message";
import { FormError } from "@/components/auth/field";
import { TradeConfirm } from "@/components/market/trade-confirm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoadingRows } from "@/components/ui/skeleton";
import { useAttemptKey } from "@/lib/attempt-key";
import { durationParts, etParts, fxDisplay } from "@/lib/forex-math";
import type { ClassStatus } from "@/lib/forex-math";
import type { FxInstrument } from "@/lib/forex";
import { formatCents, parseAmount } from "@/lib/money";
import type { Direction, OptionPeriod } from "@/lib/options";
import { bpsToPercent, estReturnCents } from "@/lib/options-math";
import { useConfirmTrades } from "@/lib/preferences";
import { rpcErrorCode, serverAnswered } from "@/lib/rpc-error";
import { feeCents } from "@/lib/spot-math";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

// Preset premiums in USD (UI only; the minimum comes from fx_periods).
const PRESETS = ["49", "1000", "5000", "10000", "30000", "50000"] as const;

// The Forex ticket, copied from the Options ticket. Every number is an estimate for display;
// open_fx_position takes no price and the entry is the first rate the server records at least
// 5 minutes after the position opens.
export function ForexTicket({
  instrument,
  price,
  periods,
  available,
  status,
  onOpened,
}: {
  instrument: FxInstrument;
  price: string | null; // last print, already formatted
  periods: OptionPeriod[] | null;
  available: bigint | null; // Forex wallet available cents
  status: ClassStatus | null; // this instrument's class, from request_fx_feed
  onOpened: () => void;
}) {
  const t = useTranslations("Forex");
  const tc = useTranslations("TradeConfirm");
  const rpcMessage = useRpcMessage();
  const attempt = useAttemptKey();
  const [direction, setDirection] = useState<Direction>("rise");
  const [chosen, setChosen] = useState<number | null>(null);
  const [amount, setAmount] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const confirmTrades = useConfirmTrades().value;

  const enabled = periods?.filter((p) => p.enabled) ?? [];
  // The chosen duration while it stays enabled, else the first enabled one.
  const period = enabled.find((p) => p.durationS === chosen) ?? enabled[0] ?? null;
  const cents = amount === "" ? null : parseAmount(amount);
  const fee = period && cents !== null ? feeCents(cents, period.feeBps) : null;
  const est = period && cents !== null ? estReturnCents(cents, period.profitRateBps) : null;
  const symbol = fxDisplay(instrument.id);
  const closed = status?.closed === true;

  let problem: string | null = null;
  if (amount !== "" && cents === null) problem = t("check.format");
  else if (period && cents !== null && cents < period.minPremium)
    problem = t("check.belowMin", { min: formatCents(period.minPremium) });
  else if (cents !== null && fee !== null && available !== null && cents + fee > available)
    problem = t("check.overBalance");

  const canSubmit =
    !pending && !closed && period !== null && cents !== null && available !== null && problem === null;
  const rise = direction === "rise";

  function change(next: () => void) {
    next();
    setError(null);
    setNotice(null);
  }

  // "Forex is closed. It opens again Sunday at 5:00 PM ET."
  function closedText(): string {
    const at = status?.opensAt ? etParts(status.opensAt) : null;
    return at ? t("closed", { weekday: at.weekday, time: at.time }) : t("closedNoTime");
  }

  function errorMessage(e: { code?: string; details?: string; message: string }): string {
    const code = rpcErrorCode(e);
    switch (code) {
      case "UNAUTHENTICATED":
      case "INVALID_ARGUMENT":
      case "WALLET_NOT_FOUND":
      case "MARKET_NOT_FOUND":
      case "MARKET_DISABLED":
      case "PERIOD_NOT_FOUND":
      case "PERIOD_DISABLED":
      case "PRICE_STALE":
      case "INSUFFICIENT_FUNDS":
      case "IDEMPOTENCY_CONFLICT":
        return t(`errors.${code}`);
      case "BELOW_MIN_PREMIUM":
        return t("errors.BELOW_MIN_PREMIUM", { min: period ? formatCents(period.minPremium) : "--" });
      case "MARKET_CLOSED": {
        // DETAIL closes_before_expiry: open now, but the position could not finish before the next closure.
        if (e.details?.includes("closes_before_expiry")) {
          const at = status?.closesAt ? etParts(status.closesAt) : null;
          return at ? t("crossing", { time: at.time }) : t("crossingNoTime");
        }
        return closedText();
      }
      default:
        return rpcMessage(e);
    }
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSubmit) return;
    // Not loaded yet (null) counts as on.
    if (confirmTrades !== false) setConfirming(true);
    else void place();
  }

  // The guard runs again here so a form that changed while the dialog was open sends nothing.
  async function place() {
    if (!canSubmit || !period || cents === null) return;
    setPending(true);
    setError(null);
    setNotice(null);
    const key = attempt.keyFor(`${instrument.id}|${direction}|${period.durationS}|${cents}`);
    const { error: rpcError } = await createClient().rpc("open_fx_position", {
      p_instrument_id: instrument.id,
      p_direction: direction,
      p_duration_s: period.durationS,
      p_premium_cents: cents.toString(),
      p_client_request_id: key,
    });
    setPending(false);
    if (rpcError) {
      // Without a server answer the position may have opened: keep the key so
      // pressing again returns that position instead of opening a second one.
      if (serverAnswered(rpcError)) attempt.settle();
      setError(errorMessage(rpcError));
      return;
    }
    attempt.settle();
    setNotice(t("opened"));
    onOpened();
  }

  const durationText = (s: number) => {
    const d = durationParts(s);
    return t(d.unit, { value: d.value });
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <ForexIcon id={instrument.id} size="sm" />
        {t.rich("currentPrice", {
          symbol,
          price: price ?? "--",
          value: (chunks) => <span className="tabular-nums text-foreground">{chunks}</span>,
        })}
      </p>

      {closed ? (
        <p role="status" className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
          {closedText()}
        </p>
      ) : null}

      <div className="space-y-3">
        <p className="text-lg font-semibold">
          {t.rich("expect", {
            symbol,
            direction: t(direction),
            dir: (chunks) => <span className={rise ? "text-up" : "text-down"}>{chunks}</span>,
          })}
        </p>
        <div className="flex justify-center gap-12">
          {(["rise", "fall"] as const).map((d) => {
            const selected = direction === d;
            const Icon = d === "rise" ? ArrowUp : ArrowDown;
            return (
              <button
                key={d}
                type="button"
                aria-pressed={selected}
                aria-label={t(d === "rise" ? "pickRise" : "pickFall")}
                onClick={() => change(() => setDirection(d))}
                className={cn(
                  "press flex size-16 items-center justify-center rounded-full",
                  d === "rise" ? "bg-up text-black" : "bg-down/60 text-white",
                  selected
                    ? d === "rise"
                      ? "opacity-100 ring-8 ring-up/25"
                      : "opacity-100 ring-8 ring-down/25"
                    : "opacity-60",
                )}
              >
                <Icon className="size-7" />
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <p className="font-medium">{t("duration")}</p>
          <p className="text-sm tabular-nums">{period ? t("pnl", { rate: bpsToPercent(period.profitRateBps) }) : "--"}</p>
        </div>
        {periods ? (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("duration")}>
            {enabled.map((p) => (
              <button
                key={p.durationS}
                type="button"
                aria-pressed={period?.durationS === p.durationS}
                onClick={() => change(() => setChosen(p.durationS))}
                className={cn(
                  "press h-9 min-w-14 rounded-md px-3 text-sm tabular-nums",
                  period?.durationS === p.durationS
                    ? "bg-primary/15 text-primary ring-1 ring-primary"
                    : "bg-muted text-foreground",
                )}
              >
                {durationText(p.durationS)}
              </button>
            ))}
          </div>
        ) : (
          <LoadingRows label={t("loading")} rows={1} rowClassName="h-9" />
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="font-medium">{t("premium")}</p>
          <p className="flex items-center gap-1.5 text-sm tabular-nums">
            {available === null ? "--" : t("available", { amount: formatCents(available) })}
            <Link href="/assets/transfer" aria-label={t("toTransfer")} className="text-primary">
              <ArrowLeftRight className="size-4" />
            </Link>
          </p>
        </div>
        <div className="grid grid-cols-6 gap-1.5">
          {PRESETS.map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={amount === v}
              onClick={() => change(() => setAmount(v))}
              className={cn(
                "press h-9 rounded-md text-xs tabular-nums sm:text-sm",
                amount === v ? "bg-primary/15 text-primary ring-1 ring-primary" : "bg-muted text-foreground",
              )}
            >
              {v}
            </button>
          ))}
        </div>
        <Input
          data-fab-avoid=""
          inputMode="decimal"
          autoComplete="off"
          aria-label={t("premiumInput")}
          placeholder={period ? t("premiumPlaceholder", { min: formatCents(period.minPremium) }) : ""}
          className="h-11 text-base tabular-nums"
          value={amount}
          aria-invalid={problem ? true : undefined}
          onChange={(e) => change(() => setAmount(e.target.value.trim()))}
        />
        <FormError message={problem} />
      </div>

      <div data-fab-avoid="" className="flex justify-between text-sm tabular-nums">
        <p className="text-muted-foreground">{t("fee", { rate: period ? bpsToPercent(period.feeBps) : "--" })}</p>
        <p className="text-muted-foreground">
          {t.rich("estReturn", {
            amount: est !== null && problem === null ? formatCents(est) : "--",
            value: (chunks) => <span className="text-primary">{chunks}</span>,
          })}
        </p>
      </div>

      <FormError message={error} />
      {notice ? (
        <p role="status" className="flex items-center gap-1.5 text-sm text-up">
          <DrawnCheck />
          {notice}
        </p>
      ) : null}

      <Button
        type="submit"
        data-fab-avoid=""
        disabled={!canSubmit}
        className={cn(
          "h-12 w-full text-base font-semibold",
          rise ? "bg-up text-black hover:bg-up/85" : "bg-down/60 text-white hover:bg-down/70",
        )}
      >
        {pending ? t("sending") : !period && periods ? t("noPeriod") : t(rise ? "call" : "put")}
      </Button>

      <TradeConfirm
        open={confirming}
        title={tc("title")}
        base={instrument.base}
        direction={rise ? "up" : "down"}
        symbolLabel={symbol}
        badge={t(rise ? "confirmCallBadge" : "confirmPutBadge")}
        rows={[
          { label: t("confirmEntry"), value: t("confirmEntryValue") },
          { label: t("confirmPremium"), value: cents !== null ? t("usd", { amount: formatCents(cents) }) : "--" },
          { label: t("confirmPeriod"), value: period ? durationText(period.durationS) : "--" },
          {
            label: t("confirmFee", { rate: period ? bpsToPercent(period.feeBps) : "--" }),
            value: fee !== null ? t("usd", { amount: formatCents(fee) }) : "--",
          },
          {
            label: t("confirmReturn"),
            value: est !== null ? t("usd", { amount: formatCents(est) }) : "--",
            tone: "up",
          },
        ]}
        note={t("infoEntry")}
        confirmLabel={tc("confirm")}
        onConfirm={() => {
          setConfirming(false);
          void place();
        }}
        onCancel={() => setConfirming(false)}
      />
    </form>
  );
}
