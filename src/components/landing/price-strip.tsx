"use client";

import { useTranslations } from "next-intl";
import { formatChange, formatPrice } from "@/lib/market/decimal";
import { isDelayed } from "@/lib/market/types";
import { useMarketData } from "@/lib/market/use-market-data";
import { cn } from "@/lib/utils";

const STRIP_IDS = ["BTC-USDT", "ETH-USDT", "SOL-USDT"] as const;

// Last price and 24 h change for BTC, ETH and SOL from the shared market store.
// "--" until the first poll lands and whenever a ticker is missing or delayed.
export function PriceStrip() {
  const t = useTranslations("Landing.prices");
  const { markets, tickers, now } = useMarketData();

  return (
    <section aria-label={t("label")} className="overflow-x-auto border-b [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <ul className="mx-auto flex w-max min-w-full max-w-6xl md:justify-center">
        {STRIP_IDS.map((id) => {
          const market = markets?.find((m) => m.id === id);
          const ticker = tickers[id];
          const live = market && ticker && !isDelayed(ticker.ts, now) ? { market, ticker } : null;
          const change = live ? formatChange(live.ticker.changePct) : "--";
          return (
            <li key={id} className="flex shrink-0 items-baseline gap-2 px-4 py-3 text-sm">
              <span className="font-medium">{t(`names.${id}`)}</span>
              <span className="text-xs text-muted-foreground">{id.replace("-", "/")}</span>
              <span className="tabular-nums">{live ? formatPrice(live.ticker.last, live.market.priceDecimals) : "--"}</span>
              <span
                aria-label={t("change24h")}
                className={cn(
                  "text-xs tabular-nums",
                  change.startsWith("+") ? "text-up" : change.startsWith("-") ? "text-down" : "text-muted-foreground",
                )}
              >
                {change}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
