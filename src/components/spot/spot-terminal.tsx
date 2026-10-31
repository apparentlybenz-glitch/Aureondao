"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { SupportFab } from "@/components/app/support-fab";
import { formatPrice, toSortNumber } from "@/lib/market/decimal";
import { DEFAULT_MARKET, readLastMarket, saveLastMarket } from "@/lib/market/last-symbol";
import { isDelayed } from "@/lib/market/types";
import { useMarketData } from "@/lib/market/use-market-data";
import { trimDecimal } from "@/lib/spot-math";
import { usePriceFeedDemand, useSpotAccount, useSpotFeeBps } from "@/lib/spot";
import { LG, useMediaQuery } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";
import { useWallets } from "@/lib/wallets";
import { AccountPanel } from "./account-panel";
import { DepthTabs } from "@/components/market/depth-tabs";
import { OrderBook } from "@/components/market/order-book";
import { TradingViewChart } from "@/components/market/tradingview-chart";
import { TradesPanel } from "./book-panels";
import { MarketPicker } from "./market-picker";
import { OrderForm } from "./order-form";

type Tab = "book" | "trades" | "orders";

// Volume is display only, so a compact float format is fine ("1.23B").
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });

// /spot?symbol=BTC-USDT. Without a symbol it opens the last viewed market
// (aureonx.lastMarket, O24). Switching markets updates the URL in place, so no
// navigation or Worker request happens.
export function SpotTerminal() {
  const t = useTranslations("Spot");
  const m = useTranslations("Market");
  const shell = useTranslations("Shell");
  const params = useSearchParams();
  const [symbol, setSymbol] = useState(() => params.get("symbol") ?? readLastMarket());
  const [tab, setTab] = useState<Tab>("book");
  const { markets, tickers, now } = useMarketData();
  const { wallets, reload: reloadWallets } = useWallets();
  const spot = wallets?.find((x) => x.account === "spot") ?? null;
  const account = useSpotAccount(spot ? spot.available.toString() : null);
  const feeBps = useSpotFeeBps();
  usePriceFeedDemand();
  const wide = useMediaQuery(LG);

  const market =
    markets?.find((x) => x.id === symbol) ?? markets?.find((x) => x.id === DEFAULT_MARKET) ?? markets?.[0] ?? null;
  const ticker = market ? tickers[market.id] : undefined;
  const holding = market ? (account.holdings?.find((h) => h.asset === market.base)?.qty ?? "0") : "0";

  useEffect(() => {
    if (market) saveLastMarket(market.id);
  }, [market]);

  function pick(id: string) {
    setSymbol(id);
    window.history.replaceState(null, "", `/spot?symbol=${encodeURIComponent(id)}`);
  }

  if (!market || !markets) {
    return <p className="px-4 py-10 text-center text-sm text-muted-foreground">{m("loading")}</p>;
  }

  const book = (
    <OrderBook
      mode="real"
      market={market}
      base={market.base}
      quote={market.quote}
      priceDecimals={market.priceDecimals}
      qtyDecimals={market.qtyDecimals}
    />
  );

  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 pt-[calc(0.75rem+var(--safe-t))] pb-[calc(var(--tab-bar-h)+5rem+var(--safe-b))] md:pb-8">
      <header className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <MarketPicker market={market} ticker={ticker} onPick={pick} />
          <p className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold tabular-nums">
              {ticker ? formatPrice(ticker.last, market.priceDecimals) : "--"}
            </span>
            {ticker && isDelayed(ticker.ts, now) ? <span className="text-xs text-muted-foreground">{m("delayed")}</span> : null}
          </p>
        </div>
        <span className="mt-1 shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground md:hidden">
          {shell("virtualPill")}
        </span>
      </header>

      <dl aria-label={t("stats.label")} className="mb-3 grid grid-cols-3 gap-2 text-xs tabular-nums">
        <div>
          <dt className="text-muted-foreground">{t("stats.high")}</dt>
          <dd>{ticker ? formatPrice(ticker.high, market.priceDecimals) : "--"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("stats.low")}</dt>
          <dd>{ticker ? formatPrice(ticker.low, market.priceDecimals) : "--"}</dd>
        </div>
        <div className="text-right">
          <dt className="text-muted-foreground">{t("stats.volume", { quote: market.quote })}</dt>
          <dd>{ticker ? compact.format(toSortNumber(ticker.quoteVolume)) : "--"}</dd>
        </div>
      </dl>

      {/* md: chart and form side by side. lg: the book is a right-hand column and the form sits under the chart. */}
      <div className="space-y-4 md:grid md:grid-cols-[minmax(0,1fr)_340px] md:gap-6 md:space-y-0 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 lg:col-start-1 lg:row-start-1">
          <TradingViewChart key={market.id} symbol={market.tvSymbol} />
        </div>
        <div className="lg:col-start-1 lg:row-start-2">
          <OrderForm
            key={market.id}
            market={market}
            ticker={ticker}
            available={spot ? spot.available : null}
            holding={trimDecimal(holding)}
            feeBps={feeBps}
            onFilled={() => {
              void account.reload();
              void reloadWallets();
            }}
          />
        </div>
        {wide ? (
          <aside className="min-w-0 lg:col-start-2 lg:row-span-2 lg:row-start-1">
            <DepthTabs book={book} trades={<TradesPanel market={market} />} />
          </aside>
        ) : null}
      </div>

      <section className="mt-5">
        {wide ? (
          <h2 className="mb-3 border-b pb-2 text-sm font-semibold">{t("tabs.orders")}</h2>
        ) : (
          <div role="tablist" className="mb-3 flex gap-5 border-b text-sm">
            {(["book", "trades", "orders"] as const).map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={cn(
                  "-mb-px border-b-2 py-2",
                  tab === key ? "border-primary font-semibold text-foreground" : "border-transparent text-muted-foreground",
                )}
              >
                {t(`tabs.${key}`)}
              </button>
            ))}
          </div>
        )}
        {!wide && tab === "book" ? book : null}
        {!wide && tab === "trades" ? <TradesPanel market={market} /> : null}
        {wide || tab === "orders" ? (
          <AccountPanel markets={markets} orders={account.orders} holdings={account.holdings} error={account.error} />
        ) : null}
      </section>
      <SupportFab />
    </div>
  );
}
