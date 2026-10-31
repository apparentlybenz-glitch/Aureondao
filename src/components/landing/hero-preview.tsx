"use client";

import { useTranslations } from "next-intl";
import { BrandMark } from "@/components/brand/brand-mark";
import { formatChange, formatPrice } from "@/lib/market/decimal";
import { isDelayed } from "@/lib/market/types";
import { useMarketData } from "@/lib/market/use-market-data";
import { cn } from "@/lib/utils";

const ID = "BTC-USDT";

// Decorative Spot ticket preview. Price, 24 h change and 24 h high come from
// the shared market store ("--" until the first poll lands and whenever the
// ticker is missing or delayed); the chart line, the amount and the buttons
// are static art and do nothing.
export function HeroPreview() {
  const t = useTranslations("Landing.preview");
  const { markets, tickers, now } = useMarketData();
  const market = markets?.find((m) => m.id === ID);
  const ticker = tickers[ID];
  const live = market && ticker && !isDelayed(ticker.ts, now) ? { market, ticker } : null;
  const change = live ? formatChange(live.ticker.changePct) : "--";

  return (
    <div aria-hidden="true" className="rounded-2xl border bg-card p-4 md:p-6">
      <div className="flex items-center justify-between gap-2 border-b pb-4">
        <div className="flex items-center gap-2 sm:gap-3">
          <BrandMark variant="small" idPrefix="preview" className="size-8" />
          <div>
            <p className="text-sm font-semibold whitespace-nowrap">BTC / USDT</p>
            <p
              className={cn(
                "text-xs tabular-nums",
                change.startsWith("+") ? "text-up" : change.startsWith("-") ? "text-down" : "text-muted-foreground",
              )}
            >
              {change}
            </p>
          </div>
        </div>
        <div className="flex rounded-lg border bg-background p-1 text-xs font-semibold">
          <span className="rounded-md bg-primary px-2.5 py-1 text-primary-foreground">{t("spot")}</span>
          <span className="px-2.5 py-1 text-muted-foreground">{t("options")}</span>
        </div>
      </div>

      <div className="mt-4 space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-2">
          <div>
            <p className="text-xs text-muted-foreground uppercase">{t("price")}</p>
            <p className="text-3xl font-semibold tabular-nums">
              {live ? formatPrice(live.ticker.last, live.market.priceDecimals) : "--"}
            </p>
          </div>
          <p className="rounded-md border bg-secondary px-2.5 py-1 text-xs tabular-nums">
            {t("high")} {live ? formatPrice(live.ticker.high, live.market.priceDecimals) : "--"}
          </p>
        </div>

        <svg viewBox="0 0 300 100" preserveAspectRatio="none" className="h-36 w-full rounded-xl border bg-background p-2">
          <path d="M 0 80 Q 40 70, 70 45 T 140 50 T 210 25 T 300 15 L 300 100 L 0 100 Z" className="fill-primary/15" />
          <path
            d="M 0 80 Q 40 70, 70 45 T 140 50 T 210 25 T 300 15"
            fill="none"
            strokeWidth="2.5"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            className="stroke-primary"
          />
        </svg>

        <div className="flex items-center justify-between rounded-xl border bg-background px-4 py-2.5 text-sm">
          <span className="text-xs text-muted-foreground">{t("amount")}</span>
          <span className="font-semibold tabular-nums">0.50</span>
        </div>
        <div className="grid grid-cols-2 gap-3 text-sm font-semibold">
          <span className="rounded-xl bg-primary py-3 text-center text-primary-foreground">{t("buy")}</span>
          <span className="rounded-xl bg-down/60 py-3 text-center">{t("sell")}</span>
        </div>
      </div>
    </div>
  );
}
