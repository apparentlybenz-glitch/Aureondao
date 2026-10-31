"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { formatPrice } from "@/lib/market/decimal";
import { CoinIcon } from "@/components/market/coin-icon";
import type { Market } from "@/lib/market/types";
import { formatCents, ZERO_CENTS } from "@/lib/money";
import { useRpcMessage } from "@/components/app/use-rpc-message";
import type { Holding, OpenOrder, SpotOrder } from "@/lib/spot";
import { compareDecimal, trimDecimal } from "@/lib/spot-math";
import { cn } from "@/lib/utils";

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

// Orders tab: the newest filled orders (all markets), the Spot holdings and the open limit orders.
export function AccountPanel({
  markets,
  orders,
  holdings,
  openOrders,
  onCancel,
  error,
}: {
  markets: Market[];
  orders: SpotOrder[] | null;
  holdings: Holding[] | null;
  openOrders: OpenOrder[] | null;
  // Cancels an order and returns the RPC error, or null on success. The caller reloads the lists.
  onCancel: (id: string) => Promise<{ code?: string; message: string } | null>;
  error: boolean;
}) {
  const t = useTranslations("Spot");
  const w = useTranslations("Wallets");
  const rpcMessage = useRpcMessage();
  const [view, setView] = useState<"history" | "holdings" | "open">("history");
  const [canceling, setCanceling] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<{ id: string; message: string } | null>(null);

  async function cancel(id: string) {
    setCanceling(id);
    setCancelError(null);
    const failure = await onCancel(id);
    setCanceling(null);
    if (failure) setCancelError({ id, message: rpcMessage(failure) });
  }
  const byId = new Map(markets.map((m) => [m.id, m]));

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        {(["history", "holdings", "open"] as const).map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={view === key}
            onClick={() => setView(key)}
            className={cn(
              "h-8 rounded-full border px-3 text-sm",
              view === key ? "border-foreground bg-foreground text-background" : "text-muted-foreground",
            )}
          >
            {key === "open" ? t("openOrders", { count: openOrders?.length ?? 0 }) : t(key)}
          </button>
        ))}
      </div>

      {error ? <p className="text-sm text-destructive">{t("listError")}</p> : null}

      {view === "history" ? (
        orders === null ? (
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        ) : orders.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t("noOrders")}</p>
        ) : (
          <ul className="space-y-2">
            {orders.map((o) => {
              const m = byId.get(o.marketId);
              return (
                <li key={o.id} className="rounded-xl border bg-card p-3 text-sm">
                  <div className="flex items-center justify-between">
                    <p className="flex items-center gap-1.5 font-medium">
                      {m ? <CoinIcon symbol={m.base} size={20} /> : null}
                      <span className={o.side === "buy" ? "text-up" : "text-down"}>{t(o.side)}</span>{" "}
                      {m ? `${m.base}/${m.quote}` : o.marketId}
                      <span className="ml-1.5 text-xs text-muted-foreground">{t(o.type)}</span>
                    </p>
                    <span className="text-xs text-muted-foreground">{t("filled")}</span>
                  </div>
                  <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs tabular-nums">
                    <dt className="text-muted-foreground">{t("qty")}</dt>
                    <dd className="text-right">{trimDecimal(o.qty)}</dd>
                    {o.limitPrice !== null ? (
                      <>
                        <dt className="text-muted-foreground">{t("limitPrice")}</dt>
                        <dd className="text-right">{m ? formatPrice(o.limitPrice, m.priceDecimals) : trimDecimal(o.limitPrice)}</dd>
                      </>
                    ) : null}
                    <dt className="text-muted-foreground">{t("price")}</dt>
                    <dd className="text-right">{m ? formatPrice(o.price, m.priceDecimals) : trimDecimal(o.price)}</dd>
                    <dt className="text-muted-foreground">{o.side === "buy" ? t("cost") : t("proceeds")}</dt>
                    <dd className="text-right">{t("usd", { amount: formatCents(o.notional) })}</dd>
                    <dt className="text-muted-foreground">{t("fee")}</dt>
                    <dd className="text-right">{t("usd", { amount: formatCents(o.fee) })}</dd>
                    {o.realizedPnl !== null ? (
                      <>
                        <dt className="text-muted-foreground">{t("realizedPnl")}</dt>
                        <dd
                          className={cn(
                            "text-right",
                            o.realizedPnl > ZERO_CENTS ? "text-up" : o.realizedPnl < ZERO_CENTS ? "text-down" : "",
                          )}
                        >
                          {t("usd", { amount: formatCents(o.realizedPnl, { sign: true }) })}
                        </dd>
                      </>
                    ) : null}
                  </dl>
                  <time dateTime={o.createdAt} className="mt-2 block text-xs text-muted-foreground">
                    {dateFormat.format(new Date(o.createdAt))}
                  </time>
                </li>
              );
            })}
          </ul>
        )
      ) : view === "open" ? (
        openOrders === null ? (
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        ) : openOrders.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t("noOpenOrders")}</p>
        ) : (
          <ul className="space-y-2">
            {openOrders.map((o) => {
              const m = byId.get(o.marketId);
              return (
                <li key={o.id} className="rounded-xl border bg-card p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <p className="flex items-center gap-1.5 font-medium">
                      {m ? <CoinIcon symbol={m.base} size={20} /> : null}
                      <span className={o.side === "buy" ? "text-up" : "text-down"}>{t(o.side)}</span>{" "}
                      {m ? `${m.base}/${m.quote}` : o.marketId}
                      <span className="ml-1.5 text-xs text-muted-foreground">{t("limit")}</span>
                    </p>
                    <button
                      type="button"
                      disabled={canceling === o.id}
                      onClick={() => void cancel(o.id)}
                      className="h-8 rounded-full border px-3 text-xs font-medium disabled:opacity-60"
                    >
                      {canceling === o.id ? t("canceling") : t("cancel")}
                    </button>
                  </div>
                  <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs tabular-nums">
                    <dt className="text-muted-foreground">{t("qty")}</dt>
                    <dd className="text-right">{trimDecimal(o.qty)}</dd>
                    <dt className="text-muted-foreground">{t("limitPrice")}</dt>
                    <dd className="text-right">{m ? formatPrice(o.limitPrice, m.priceDecimals) : trimDecimal(o.limitPrice)}</dd>
                    <dt className="text-muted-foreground">{t("reserved")}</dt>
                    <dd className="text-right">
                      {o.holdCents !== null
                        ? t("usd", { amount: formatCents(o.holdCents) })
                        : `${trimDecimal(o.holdQty ?? "0")} ${m?.base ?? ""}`.trim()}
                    </dd>
                  </dl>
                  {cancelError?.id === o.id ? <p className="mt-2 text-xs text-destructive">{cancelError.message}</p> : null}
                  <time dateTime={o.createdAt} className="mt-2 block text-xs text-muted-foreground">
                    {dateFormat.format(new Date(o.createdAt))}
                  </time>
                </li>
              );
            })}
          </ul>
        )
      ) : holdings === null ? (
        <p className="text-sm text-muted-foreground">{t("loading")}</p>
      ) : holdings.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{t("noHoldings")}</p>
      ) : (
        <ul className="space-y-2">
          {holdings.map((h) => (
            <li key={h.asset} className="flex items-center justify-between rounded-xl border bg-card p-3 text-sm">
              <span className="flex items-center gap-2">
                <CoinIcon symbol={h.asset} size={24} />
                <span>
                  <span className="block font-medium">{h.asset}</span>
                  <span className="block text-xs text-muted-foreground">{w("spot")}</span>
                </span>
              </span>
              <span className="text-right tabular-nums">
                <span className="block font-medium">{trimDecimal(h.qty)}</span>
                {compareDecimal(h.held, "0") > 0 ? (
                  <span className="block text-xs text-muted-foreground">
                    {t("inOpenOrders")}: {trimDecimal(h.held)}
                  </span>
                ) : null}
                <span className="block text-xs text-muted-foreground">
                  {t("costBasis")}: {t("usd", { amount: formatCents(h.costBasis) })}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
