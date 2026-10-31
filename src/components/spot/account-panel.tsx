"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { formatPrice } from "@/lib/market/decimal";
import { CoinIcon } from "@/components/market/coin-icon";
import type { Market } from "@/lib/market/types";
import { formatCents, ZERO_CENTS } from "@/lib/money";
import type { Holding, SpotOrder } from "@/lib/spot";
import { trimDecimal } from "@/lib/spot-math";
import { cn } from "@/lib/utils";

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

// Orders tab: the newest filled orders (all markets) and the Spot holdings.
export function AccountPanel({
  markets,
  orders,
  holdings,
  error,
}: {
  markets: Market[];
  orders: SpotOrder[] | null;
  holdings: Holding[] | null;
  error: boolean;
}) {
  const t = useTranslations("Spot");
  const w = useTranslations("Wallets");
  const [view, setView] = useState<"history" | "holdings">("history");
  const byId = new Map(markets.map((m) => [m.id, m]));

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        {(["history", "holdings"] as const).map((key) => (
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
            {t(key)}
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
                      <span className="ml-1.5 text-xs text-muted-foreground">{t("market")}</span>
                    </p>
                    <span className="text-xs text-muted-foreground">{t("filled")}</span>
                  </div>
                  <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs tabular-nums">
                    <dt className="text-muted-foreground">{t("qty")}</dt>
                    <dd className="text-right">{trimDecimal(o.qty)}</dd>
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
