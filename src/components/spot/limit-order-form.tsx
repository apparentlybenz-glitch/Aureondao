"use client";

import Link from "next/link";
import { useState } from "react";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { useRpcMessage } from "@/components/app/use-rpc-message";
import { FormError } from "@/components/auth/field";
import { TradeConfirm } from "@/components/market/trade-confirm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAttemptKey } from "@/lib/attempt-key";
import { formatPrice } from "@/lib/market/decimal";
import { formatCents, ZERO_CENTS } from "@/lib/money";
import { useConfirmTrades } from "@/lib/preferences";
import { rpcErrorCode, serverAnswered } from "@/lib/rpc-error";
import { fetchOrder } from "@/lib/spot";
import type { SpotOrder } from "@/lib/spot";
import {
  buyQtyFor,
  checkPrice,
  checkQty,
  compareDecimal,
  feeCents,
  isMarketable,
  limitReserveCents,
  meetsMinimum,
  sellQtyFor,
  trimDecimal,
  valueCents,
} from "@/lib/spot-math";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import type { OrderFormProps } from "./order-form";

const STEPS = [0, 25, 50, 75, 100] as const;
type Side = "buy" | "sell";
type Result = { kind: "filled"; order: SpotOrder | null } | { kind: "rested" };

// Limit order ticket. The only price the RPC takes is the user's own limit; everything else
// (the fill price, the fee rate) is the server's. A limit the market already satisfies fills
// at once at the server's best price, otherwise the order rests and reserves its funds or
// quantity until it fills at the limit or is canceled. Every number shown before placing is
// an estimate from the browser's ticker.
export function LimitOrderForm({
  market,
  ticker,
  available,
  holding,
  feeBps,
  onFilled,
  onRested,
  typeTabs,
}: OrderFormProps & { typeTabs: ReactNode }) {
  const t = useTranslations("Spot");
  const tc = useTranslations("TradeConfirm");
  const rpcMessage = useRpcMessage();
  const attempt = useAttemptKey();
  const [side, setSide] = useState<Side>("buy");
  // null = the user has not typed a price: the field shows the seed below.
  const [priceInput, setPriceInput] = useState<string | null>(null);
  // The side's own best price, taken once per side (and on "Use best"), so the field does not
  // move under the user when the ticker updates.
  const [seed, setSeed] = useState<{ side: Side; price: string } | null>(null);
  const [qty, setQty] = useState("");
  const [pct, setPct] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [confirming, setConfirming] = useState(false);
  const confirmTrades = useConfirmTrades().value;

  const asset = market.base;
  const best = ticker ? trimDecimal(side === "buy" ? ticker.bid : ticker.ask) : null;
  if (best !== null && seed?.side !== side) setSeed({ side, price: best });
  const priceText = priceInput ?? seed?.price ?? "";

  const priceCheck = checkPrice(priceText, market.priceDecimals);
  const qtyCheck = checkQty(qty, market.qtyDecimals);
  const marketable = priceCheck.ok && !!ticker && isMarketable(side, priceCheck.price, ticker.bid, ticker.ask);

  // Estimate. A marketable limit fills at the ticker's ask or bid; a resting one at its limit.
  const execPrice = priceCheck.ok ? (marketable && ticker ? (side === "buy" ? ticker.ask : ticker.bid) : priceCheck.price) : null;
  const est =
    qtyCheck.ok && execPrice !== null && feeBps !== null
      ? (() => {
          const cents = valueCents(qtyCheck.qty, execPrice, side === "buy" ? "ceil" : "floor");
          return { cents, fee: feeCents(cents, feeBps) };
        })()
      : null;
  // Cash a buy needs: the estimate when it fills now, the hold when it rests.
  const reserve =
    qtyCheck.ok && priceCheck.ok && feeBps !== null && side === "buy"
      ? limitReserveCents(qtyCheck.qty, priceCheck.price, feeBps)
      : null;
  const needed = side === "buy" ? (marketable && est ? est.cents + est.fee : reserve) : null;

  let problem: string | null = null;
  if (!priceCheck.ok && priceCheck.reason !== "empty") {
    problem =
      priceCheck.reason === "decimals"
        ? t("check.priceDecimals", { decimals: market.priceDecimals })
        : priceCheck.reason === "zero"
          ? t("check.priceZero")
          : t("check.priceFormat");
  } else if (!qtyCheck.ok && qtyCheck.reason !== "empty") {
    problem =
      qtyCheck.reason === "decimals"
        ? t("check.decimals", { decimals: market.qtyDecimals, asset })
        : t(`check.${qtyCheck.reason}`);
  } else if (priceCheck.ok && qtyCheck.ok) {
    if (!meetsMinimum(qtyCheck.qty, priceCheck.price, market.minNotionalCents)) {
      problem = t("check.belowMin", { min: formatCents(market.minNotionalCents) });
    } else if (side === "buy" && needed !== null && available !== null && needed > available) {
      problem = t("check.overBalance");
    } else if (side === "sell" && compareDecimal(qtyCheck.qty, holding) > 0) {
      problem = t("check.overHolding", { asset });
    }
  }

  const canSubmit = !pending && priceCheck.ok && qtyCheck.ok && feeBps !== null && available !== null && problem === null;

  function clearMessages() {
    setError(null);
    setResult(null);
  }

  function reset(nextSide: Side) {
    setSide(nextSide);
    setPriceInput(null);
    setQty("");
    setPct(0);
    clearMessages();
  }

  function resetToBest() {
    if (best === null) return;
    setSeed({ side, price: best });
    setPriceInput(null);
    setPct(0);
    clearMessages();
  }

  function onSlide(next: number) {
    setPct(next);
    clearMessages();
    if (next === 0) return setQty("");
    let q = "0";
    if (side === "buy" && priceCheck.ok && feeBps !== null && available !== null) {
      // Sized at the limit price, which is what a resting order reserves: no headroom needed.
      q = buyQtyFor((available * BigInt(next)) / BigInt(100), priceCheck.price, feeBps, market.qtyDecimals, 0);
    } else if (side === "sell") {
      q = sellQtyFor(holding, next, market.qtyDecimals);
    }
    setQty(q === "0" ? "" : q);
  }

  function errorMessage(e: { code?: string; message: string }): string {
    switch (rpcErrorCode(e)) {
      case "INSUFFICIENT_FUNDS":
        return t("errors.INSUFFICIENT_FUNDS");
      case "INSUFFICIENT_ASSET":
        return t("errors.INSUFFICIENT_ASSET", { asset });
      case "BELOW_MIN_NOTIONAL":
        return t("errors.BELOW_MIN_NOTIONAL", { min: formatCents(market.minNotionalCents) });
      case "INVALID_QTY":
        return t("errors.INVALID_QTY", { decimals: market.qtyDecimals, asset });
      case "INVALID_PRICE":
        return t("errors.INVALID_PRICE", { decimals: market.priceDecimals });
      case "IDEMPOTENCY_CONFLICT":
        return t("errors.IDEMPOTENCY_CONFLICT");
      default:
        return rpcMessage(e);
    }
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSubmit || !priceCheck.ok || !qtyCheck.ok) return;
    // Not loaded yet (null) counts as on.
    if (confirmTrades !== false) setConfirming(true);
    else void place();
  }

  // The guard runs again here so a form that changed while the dialog was open sends nothing.
  async function place() {
    if (!canSubmit || !priceCheck.ok || !qtyCheck.ok) return;
    setPending(true);
    clearMessages();
    const key = attempt.keyFor(`${market.id}|${side}|${qtyCheck.qty}|${priceCheck.price}`);
    const { data, error: rpcError } = await createClient().rpc("spot_limit_order", {
      p_market_id: market.id,
      p_side: side,
      p_qty: qtyCheck.qty,
      p_limit_price: priceCheck.price,
      p_client_request_id: key,
    });
    if (rpcError) {
      // Without a server answer the order may have been placed: keep the key so a retry of
      // this attempt cannot place it twice.
      if (serverAnswered(rpcError)) attempt.settle();
      setPending(false);
      setError(errorMessage(rpcError));
      return;
    }
    attempt.settle();
    // The RPC's own response carries numbers as JSON floats: only its id and status are used.
    const row = data as { id?: unknown; status?: unknown } | null;
    const filled = row?.status === "filled";
    const order = filled && typeof row?.id === "string" ? await fetchOrder(row.id) : null;
    setPending(false);
    setResult(filled ? { kind: "filled", order } : { kind: "rested" });
    setQty("");
    setPct(0);
    if (filled) onFilled();
    else onRested();
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
        <div className="flex items-center justify-between">
          <label htmlFor="limit-price" className="text-xs text-muted-foreground">
            {t("priceInput")}
          </label>
          <button
            type="button"
            disabled={best === null}
            onClick={resetToBest}
            className="text-xs font-medium text-primary disabled:opacity-50"
          >
            {side === "buy" ? t("useBestBid") : t("useBestAsk")}
          </button>
        </div>
        <Input
          id="limit-price"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0"
          className="h-11 text-base tabular-nums"
          value={priceText}
          aria-invalid={!priceCheck.ok && priceCheck.reason !== "empty" ? true : undefined}
          onChange={(e) => {
            setPriceInput(e.target.value.trim());
            setPct(0);
            clearMessages();
          }}
        />
        {marketable ? <p className="text-xs text-primary">{t("fillsNow")}</p> : null}
      </div>

      <div className="space-y-1.5">
        <label htmlFor="limit-qty" className="text-xs text-muted-foreground">
          {t("quantity", { asset })}
        </label>
        <Input
          id="limit-qty"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0"
          className="h-11 text-base tabular-nums"
          value={qty}
          aria-invalid={!qtyCheck.ok && qtyCheck.reason !== "empty" ? true : undefined}
          onChange={(e) => {
            setQty(e.target.value.trim());
            setPct(0);
            clearMessages();
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
          disabled={!priceCheck.ok || (side === "buy" ? !available || feeBps === null : holding === "0")}
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

      {/* While a result is shown the estimate would only read "--": hide it so the card keeps its height. */}
      {result === null ? (
        <div className="space-y-1 rounded-lg bg-muted/40 p-2.5 text-xs">
          <p className="font-semibold text-muted-foreground">{t("estimate")}</p>
          <dl className="space-y-1">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">{t("estPrice")}</dt>
              <dd className="tabular-nums">{execPrice ? formatPrice(execPrice, market.priceDecimals) : "--"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">{side === "buy" ? t("estCost") : t("estProceeds")}</dt>
              <dd className="tabular-nums">{est ? t("usd", { amount: formatCents(est.cents) }) : "--"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">{t("estFee", { rate: feeBps === null ? "--" : `${feeBps / 100}%` })}</dt>
              <dd className="tabular-nums">{est ? t("usd", { amount: formatCents(est.fee) }) : "--"}</dd>
            </div>
            {!marketable ? (
              <div className="flex justify-between">
                <dt className="text-muted-foreground">{t("estReserved")}</dt>
                <dd className="tabular-nums">
                  {side === "buy"
                    ? reserve !== null
                      ? t("usd", { amount: formatCents(reserve) })
                      : "--"
                    : qtyCheck.ok
                      ? t("availableAsset", { amount: trimDecimal(qtyCheck.qty), asset })
                      : "--"}
                </dd>
              </div>
          ) : null}
        </dl>
        <p className="pt-1 text-[11px] text-muted-foreground">{marketable ? t("estimateNote") : t("estReservedNote")}</p>
      </div>
      ) : null}

      <FormError message={error} />
      {result?.kind === "rested" ? (
        <div role="status" className="space-y-1 rounded-lg border border-up/40 p-2.5 text-xs">
          <p className="font-semibold text-up">{t("placedTitle")}</p>
          <p>{t("placedBody")}</p>
        </div>
      ) : null}
      {result?.kind === "filled" ? (
        <div role="status" className="space-y-1 rounded-lg border border-up/40 p-2.5 text-xs">
          <p className="font-semibold text-up">{t("filledTitle")}</p>
          {result.order ? (
            <>
              <p>
                {t(result.order.side === "buy" ? "filledBuy" : "filledSell", {
                  qty: trimDecimal(result.order.qty),
                  asset,
                  price: formatPrice(result.order.price, market.priceDecimals),
                })}
              </p>
              <p className="flex justify-between tabular-nums">
                <span className="text-muted-foreground">{result.order.side === "buy" ? t("cost") : t("proceeds")}</span>
                {t("usd", { amount: formatCents(result.order.notional) })}
              </p>
              <p className="flex justify-between tabular-nums">
                <span className="text-muted-foreground">{t("fee")}</span>
                {t("usd", { amount: formatCents(result.order.fee) })}
              </p>
            </>
          ) : null}
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
        {pending ? t("sending") : t(side === "buy" ? "placeBuy" : "placeSell")}
      </Button>

      <TradeConfirm
        open={confirming}
        title={tc("title")}
        base={asset}
        direction={side === "buy" ? "up" : "down"}
        symbolLabel={market.displaySymbol}
        badge={t(side === "buy" ? "confirmBuyLimitBadge" : "confirmSellLimitBadge")}
        rows={[
          { label: t("limitPrice"), value: priceCheck.ok ? formatPrice(priceCheck.price, market.priceDecimals) : "--" },
          { label: t("quantity", { asset }), value: qtyCheck.ok ? qtyCheck.qty : "--" },
          {
            label: side === "buy" ? t("confirmEstCost") : t("confirmEstProceeds"),
            value: est ? t("usd", { amount: formatCents(est.cents) }) : "--",
          },
          {
            label: t("confirmEstFee", { rate: feeBps === null ? "--" : `${feeBps / 100}%` }),
            value: est ? t("usd", { amount: formatCents(est.fee) }) : "--",
          },
        ]}
        note={marketable ? t("estimateNote") : t("estReservedNote")}
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
