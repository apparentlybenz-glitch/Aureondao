"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowDown, ArrowLeftRight, ArrowUp } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRpcMessage } from "@/components/app/use-rpc-message";
import { FormError } from "@/components/auth/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { useAttemptKey } from "@/lib/attempt-key";
import { formatPrice } from "@/lib/market/decimal";
import type { Market } from "@/lib/market/types";
import { formatCents, parseAmount } from "@/lib/money";
import { bpsToPercent, estReturnCents } from "@/lib/options-math";
import type { Direction, OptionPeriod } from "@/lib/options";
import { rpcErrorCode, serverAnswered } from "@/lib/rpc-error";
import { feeCents } from "@/lib/spot-math";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

// Preset premiums in USD (UI only; the minimum comes from option_periods).
const PRESETS = ["49", "1000", "5000", "10000", "30000", "50000"] as const;
// The slider thumb is 12 px wide; Radix keeps it inside the track, so a stop at
// p% sits at p% + (6 - 0.12 p) px.
const stopLeft = (pct: number) => `calc(${pct}% + ${6 - 0.12 * pct}px)`;

// The Options ticket. Every number here is an estimate for display; open_option
// takes no price and the server prices the entry from its own snapshot.
export function OptionTicket({
  market,
  mid,
  periods,
  available,
  onOpened,
}: {
  market: Market;
  mid: string | null; // browser display mid, never sent
  periods: OptionPeriod[] | null;
  available: bigint | null; // Options wallet available cents
  onOpened: () => void;
}) {
  const t = useTranslations("Options");
  const rpcMessage = useRpcMessage();
  const attempt = useAttemptKey();
  const [direction, setDirection] = useState<Direction>("rise");
  const [chosen, setChosen] = useState<number | null>(null);
  const [amount, setAmount] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // The chosen period while it stays enabled, else the first enabled one.
  const period =
    periods?.find((p) => p.durationS === chosen && p.enabled) ?? periods?.find((p) => p.enabled) ?? null;
  const cents = amount === "" ? null : parseAmount(amount);
  const fee = period && cents !== null ? feeCents(cents, period.feeBps) : null;
  const est = period && cents !== null ? estReturnCents(cents, period.profitRateBps) : null;

  let problem: string | null = null;
  if (amount !== "" && cents === null) problem = t("check.format");
  else if (period && cents !== null && cents < period.minPremium)
    problem = t("check.belowMin", { min: formatCents(period.minPremium) });
  else if (cents !== null && fee !== null && available !== null && cents + fee > available)
    problem = t("check.overBalance");

  const canSubmit = !pending && period !== null && cents !== null && available !== null && problem === null;
  const rise = direction === "rise";

  function change(next: () => void) {
    next();
    setError(null);
    setNotice(null);
  }

  function errorMessage(e: { code?: string; message: string }): string {
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
      default:
        return rpcMessage(e);
    }
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSubmit || !period || cents === null) return;
    setPending(true);
    setError(null);
    setNotice(null);
    const key = attempt.keyFor(`${market.id}|${direction}|${period.durationS}|${cents}`);
    const { error: rpcError } = await createClient().rpc("open_option", {
      p_market_id: market.id,
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
    setNotice(t("opened", { seconds: period.durationS }));
    onOpened();
  }

  const index = periods && period ? periods.findIndex((p) => p.durationS === period.durationS) : 0;
  const last = periods ? Math.max(periods.length - 1, 1) : 1;

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <p className="text-xs text-muted-foreground">
        {t.rich("currentPrice", {
          symbol: market.displaySymbol,
          price: mid ? formatPrice(mid, market.priceDecimals) : "--",
          value: (chunks) => <span className={cn("tabular-nums", rise ? "text-up" : "text-down")}>{chunks}</span>,
        })}
      </p>

      <div className="space-y-3">
        <p className="text-lg font-semibold">
          {t.rich("expect", {
            symbol: market.displaySymbol,
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
                  "flex size-16 items-center justify-center rounded-full transition-[box-shadow,opacity]",
                  d === "rise" ? "bg-up text-black" : "bg-down/70 text-white",
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
          <p className="font-medium">{t("periods")}</p>
          <p className="text-sm tabular-nums">{period ? t("pnl", { rate: bpsToPercent(period.profitRateBps) }) : "--"}</p>
        </div>
        {periods ? (
          <div className="px-1">
            <div className="relative py-2">
              <Slider
                min={0}
                max={last}
                step={1}
                value={[index]}
                disabled={!period}
                aria-label={t("periodSlider")}
                onValueChange={([i]) => {
                  const p = periods[i];
                  if (p?.enabled) change(() => setChosen(p.durationS));
                }}
              />
              {periods.map((p, i) => (
                <span
                  key={p.durationS}
                  aria-hidden="true"
                  style={{ left: stopLeft((i / last) * 100) }}
                  className={cn(
                    "pointer-events-none absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2",
                    !p.enabled
                      ? "border-muted bg-muted"
                      : i <= index
                        ? "border-primary bg-primary"
                        : "border-foreground bg-background",
                    i === index && "opacity-0",
                  )}
                />
              ))}
            </div>
            <div className="relative h-4 text-xs tabular-nums">
              {periods.map((p, i) => (
                <span
                  key={p.durationS}
                  style={{ left: stopLeft((i / last) * 100) }}
                  className={cn(
                    "absolute -translate-x-1/2",
                    !p.enabled ? "text-muted-foreground/40" : i === index ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {p.durationS}
                </span>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
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
                "h-9 rounded-md text-xs tabular-nums sm:text-sm",
                amount === v ? "bg-primary/15 text-primary ring-1 ring-primary" : "bg-muted text-foreground",
              )}
            >
              {v}
            </button>
          ))}
        </div>
        <Input
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
        <p className="text-muted-foreground">
          {t("fee", { rate: period ? bpsToPercent(period.feeBps) : "--" })}
        </p>
        <p className="text-muted-foreground">
          {t.rich("estReturn", {
            amount: est !== null && problem === null ? formatCents(est) : "--",
            value: (chunks) => <span className="text-amber-500">{chunks}</span>,
          })}
        </p>
      </div>

      <FormError message={error} />
      {notice ? (
        <p role="status" className="text-sm text-up">
          {notice}
        </p>
      ) : null}

      <Button
        type="submit"
        data-fab-avoid=""
        disabled={!canSubmit}
        className={cn(
          "h-12 w-full text-base font-semibold",
          rise ? "bg-up text-black hover:bg-up/85" : "bg-down/80 text-white hover:bg-down/70",
        )}
      >
        {pending ? t("sending") : !period && periods ? t("noPeriod") : t(rise ? "call" : "put")}
      </Button>
    </form>
  );
}
