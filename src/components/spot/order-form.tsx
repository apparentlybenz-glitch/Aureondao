"use client";

import Link from "next/link";
import { useState } from "react";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { useRpcMessage } from "@/components/app/use-rpc-message";
import { FormError } from "@/components/auth/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAttemptKey } from "@/lib/attempt-key";
import { formatPrice } from "@/lib/market/decimal";
import type { Market, Ticker } from "@/lib/market/types";
import { formatCents, ZERO_CENTS } from "@/lib/money";
import { rpcErrorCode, serverAnswered } from "@/lib/rpc-error";
import { fetchOrder } from "@/lib/spot";
import type { SpotOrder } from "@/lib/spot";
import {
  buyQtyFor,
  checkQty,
  compareDecimal,
  feeCents,
  MAX_BUY_BUFFER_BPS,
  meetsMinimum,
  sellQtyFor,
  trimDecimal,
  valueCents,
} from "@/lib/spot-math";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { LimitOrderForm } from "./limit-order-form";
import { OrderTypeTabs } from "./order-type-tabs";
import type { OrderType } from "./order-type-tabs";

const STEPS = [0, 25, 50, 75, 100] as const;
type Side = "buy" | "sell";

export type OrderFormProps = {
  market: Market;
  ticker: Ticker | undefined;
  available: bigint | null; // Spot wallet available cents
  holding: string; // available quantity of the base asset
  feeBps: number | null;
  onFilled: () => void;
  // A limit order that rested (nothing filled yet).
  onRested: () => void;
};

// The Spot ticket: Market or Limit. Each is its own form, so each renders one root <form>
// (the desktop Trading card styles its direct <form> child).
export function OrderForm({ onRested, ...props }: OrderFormProps) {
  const [type, setType] = useState<OrderType>("market");
  const tabs = <OrderTypeTabs type={type} onChange={setType} />;
  return type === "market" ? (
    <MarketTicket {...props} typeTabs={tabs} />
  ) : (
    <LimitOrderForm {...props} onRested={onRested} typeTabs={tabs} />
  );
}

// Market order ticket. Every number shown before the fill is an estimate from
// the browser's ticker; the RPC takes no price and fills at the server snapshot.
// After a fill the order row (read back as text) is shown instead.
function MarketTicket({
  market,
  ticker,
  available,
  holding,
  feeBps,
  onFilled,
  typeTabs,
}: Omit<OrderFormProps, "onRested"> & { typeTabs: ReactNode }) {
  const t = useTranslations("Spot");
  const rpcMessage = useRpcMessage();
  const attempt = useAttemptKey();
  const [side, setSide] = useState<Side>("buy");
  const [qty, setQty] = useState("");
  const [pct, setPct] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fill, setFill] = useState<SpotOrder | null>(null);

  const asset = market.base;
  const price = ticker ? (side === "buy" ? ticker.ask : ticker.bid) : null;
  const check = checkQty(qty, market.qtyDecimals);
  const est =
    check.ok && price
      ? (() => {
          const cents = valueCents(check.qty, price, side === "buy" ? "ceil" : "floor");
          return { cents, fee: feeBps === null ? null : feeCents(cents, feeBps) };
        })()
      : null;

  let problem: string | null = null;
  if (!check.ok && check.reason !== "empty") {
    problem =
      check.reason === "decimals"
        ? t("check.decimals", { decimals: market.qtyDecimals, asset })
        : t(`check.${check.reason}`);
  } else if (check.ok && price && !meetsMinimum(check.qty, price, market.minNotionalCents)) {
    problem = t("check.belowMin", { min: formatCents(market.minNotionalCents) });
  } else if (check.ok && side === "buy" && est?.fee != null && available !== null && est.cents + est.fee > available) {
    problem = t("check.overBalance");
  } else if (check.ok && side === "sell" && compareDecimal(check.qty, holding) > 0) {
    problem = t("check.overHolding", { asset });
  }

  const canSubmit = !pending && !!ticker && check.ok && feeBps !== null && available !== null && problem === null;

  function reset(nextSide: Side) {
    setSide(nextSide);
    setQty("");
    setPct(0);
    setError(null);
    setFill(null);
  }

  function onSlide(next: number) {
    setPct(next);
    setFill(null);
    setError(null);
    if (next === 0) return setQty("");
    let q = "0";
    if (side === "buy" && ticker && feeBps !== null && available !== null) {
      // 100 % keeps 0.5 % headroom on the price so the fill still fits the balance.
      q = buyQtyFor(
        (available * BigInt(next)) / BigInt(100),
        ticker.ask,
        feeBps,
        market.qtyDecimals,
        next === 100 ? MAX_BUY_BUFFER_BPS : 0,
      );
    } else if (side === "sell") {
      q = sellQtyFor(holding, next, market.qtyDecimals);
    }
    setQty(q === "0" ? "" : q);
  }

  function errorMessage(e: { code?: string; message: string }): string {
    switch (rpcErrorCode(e)) {
      case "PRICE_STALE":
        return t("errors.PRICE_STALE");
      case "INSUFFICIENT_FUNDS":
        return t("errors.INSUFFICIENT_FUNDS");
      case "INSUFFICIENT_ASSET":
        return t("errors.INSUFFICIENT_ASSET", { asset });
      case "BELOW_MIN_NOTIONAL":
        return t("errors.BELOW_MIN_NOTIONAL", { min: formatCents(market.minNotionalCents) });
      case "INVALID_QTY":
      case "INVALID_NUMBER":
        return t("errors.INVALID_QTY", { decimals: market.qtyDecimals, asset });
      case "IDEMPOTENCY_CONFLICT":
        return t("errors.IDEMPOTENCY_CONFLICT");
      default:
        return rpcMessage(e);
    }
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSubmit || !check.ok) return;
    setPending(true);
    setError(null);
    setFill(null);
    const key = attempt.keyFor(`${market.id}|${side}|${check.qty}`);
    const { data, error: rpcError } = await createClient().rpc("spot_market_order", {
      p_market_id: market.id,
      p_side: side,
      p_qty: check.qty,
      p_client_request_id: key,
    });
    if (rpcError) {
      // Without a server answer the order may have filled: keep the key so a
      // retry of this attempt cannot fill twice.
      if (serverAnswered(rpcError)) attempt.settle();
      setPending(false);
      setError(errorMessage(rpcError));
      return;
    }
    attempt.settle();
    const id = (data as { id?: unknown } | null)?.id;
    const order = typeof id === "string" ? await fetchOrder(id) : null;
    setPending(false);
    setFill(order);
    setQty("");
    setPct(0);
    onFilled();
  }

  const sideButton = (s: Side) => (
    <button
      type="button"
      aria-pressed={side === s}
      onClick={() => reset(s)}
      className={cn(
        "h-9 rounded-lg text-sm font-semibold",
        side === s ? (s === "buy" ? "bg-up text-black" : "bg-down/60 text-white") : "bg-muted text-muted-foreground",
      )}
    >
      {t(s)}
    </button>
  );

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-xl border bg-card p-3">
      <div className="grid grid-cols-2 gap-2">
        {sideButton("buy")}
        {sideButton("sell")}
      </div>

      {typeTabs}

      <p className="flex justify-between text-xs text-muted-foreground">
        <span>{t("available")}</span>
        <span className="tabular-nums text-foreground">
          {side === "buy"
            ? available === null
              ? "--"
              : t("availableUsd", { amount: formatCents(available) })
            : t("availableAsset", { amount: trimDecimal(holding), asset })}
        </span>
      </p>
      {side === "buy" && available === ZERO_CENTS ? (
        <p className="text-xs text-muted-foreground">
          {t("fundHint")}{" "}
          <Link href="/assets/transfer" className="font-medium text-primary">
            {t("toTransfer")}
          </Link>
        </p>
      ) : null}

      <div className="space-y-1.5">
        <label htmlFor="spot-qty" className="text-xs text-muted-foreground">
          {t("quantity", { asset })}
        </label>
        <Input
          id="spot-qty"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0"
          className="h-11 text-base tabular-nums"
          value={qty}
          aria-invalid={problem ? true : undefined}
          onChange={(e) => {
            setQty(e.target.value.trim());
            setPct(0);
            setFill(null);
            setError(null);
          }}
        />
      </div>

      <div className="space-y-1">
        <input
          type="range"
          min={0}
          max={100}
          step={25}
          value={pct}
          aria-label={t("percent")}
          disabled={!ticker || (side === "buy" ? !available || feeBps === null : holding === "0")}
          onChange={(e) => onSlide(Number(e.target.value))}
          className="w-full accent-primary"
        />
        <div data-fab-avoid="" className="flex justify-between text-[11px] text-muted-foreground tabular-nums">
          {STEPS.map((s) => (
            <span key={s}>{s}%</span>
          ))}
        </div>
      </div>

      <FormError message={problem} />

      <div className="space-y-1 rounded-lg bg-muted/40 p-2.5 text-xs">
        <p className="font-semibold text-muted-foreground">{t("estimate")}</p>
        <dl className="space-y-1">
        <div className="flex justify-between">
          <dt className="text-muted-foreground">{t("estPrice")}</dt>
          <dd className="tabular-nums">{price ? formatPrice(price, market.priceDecimals) : "--"}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">{side === "buy" ? t("estCost") : t("estProceeds")}</dt>
          <dd className="tabular-nums">{est ? t("usd", { amount: formatCents(est.cents) }) : "--"}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">{t("estFee", { rate: feeBps === null ? "--" : `${feeBps / 100}%` })}</dt>
          <dd className="tabular-nums">{est?.fee != null ? t("usd", { amount: formatCents(est.fee) }) : "--"}</dd>
        </div>
        </dl>
        <p className="pt-1 text-[11px] text-muted-foreground">{t("estimateNote")}</p>
      </div>

      <FormError message={error} />
      {fill ? (
        <div role="status" className="space-y-1 rounded-lg border border-up/40 p-2.5 text-xs">
          <p className="font-semibold text-up">{t("filledTitle")}</p>
          <p>
            {t(fill.side === "buy" ? "filledBuy" : "filledSell", {
              qty: trimDecimal(fill.qty),
              asset,
              price: formatPrice(fill.price, market.priceDecimals),
            })}
          </p>
          <p className="flex justify-between tabular-nums">
            <span className="text-muted-foreground">{fill.side === "buy" ? t("cost") : t("proceeds")}</span>
            {t("usd", { amount: formatCents(fill.notional) })}
          </p>
          <p className="flex justify-between tabular-nums">
            <span className="text-muted-foreground">{t("fee")}</span>
            {t("usd", { amount: formatCents(fill.fee) })}
          </p>
        </div>
      ) : null}

      <Button
        type="submit"
        data-fab-avoid=""
        disabled={!canSubmit}
        className={cn(
          "h-11 w-full text-base font-semibold",
          side === "buy" ? "bg-up text-black hover:bg-up/85" : "bg-down/60 text-white hover:bg-down/70",
        )}
      >
        {!ticker ? t("pricesUnavailable") : pending ? t("sending") : t(side === "buy" ? "confirmBuy" : "confirmSell", { asset })}
      </Button>
    </form>
  );
}
