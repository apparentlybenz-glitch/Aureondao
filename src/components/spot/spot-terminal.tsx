"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { SupportFab } from "@/components/app/support-fab";
import { formatPrice, toSortNumber } from "@/lib/market/decimal";
import { DEFAULT_MARKET, readLastMarket, saveLastMarket } from "@/lib/market/last-symbol";
import { isDelayed } from "@/lib/market/types";
import { useMarketData } from "@/lib/market/use-market-data";
import { tabAfterOrder } from "@/lib/depth-tab";
import { trimDecimal } from "@/lib/spot-math";
import { cancelOrder, usePriceFeedDemand, useSpotAccount, useSpotFeeBps } from "@/lib/spot";
import { LG, XL, useMediaQuery } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";
import { useWallets } from "@/lib/wallets";
import { AccountPanel } from "./account-panel";
import { DepthTabs } from "@/components/market/depth-tabs";
import { DesktopTerminal } from "@/components/market/desktop-terminal";
import { CryptoStrip } from "@/components/market/terminal-strip";
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
  const walletsT = useTranslations("Wallets");
  const params = useSearchParams();
  const [symbol, setSymbol] = useState(() => params.get("symbol") ?? readLastMarket());
  const [tab, setTab] = useState<Tab>("book");
  // The one tab state: below lg it drives Book / Trades / Orders, from lg the depth panel shows it.
  const depthTab = tab === "trades" ? "trades" : "book";
  const { markets, tickers, now } = useMarketData();
  const { wallets, reload: reloadWallets } = useWallets();
  const spot = wallets?.find((x) => x.account === "spot") ?? null;
  // Available and held both: a resting sell or a buy fill changes held funds or holdings, not available.
  const account = useSpotAccount(spot ? `${spot.available}|${spot.held}` : null);
  const feeBps = useSpotFeeBps();
  usePriceFeedDemand();
  const wide = useMediaQuery(LG);
  const desktop = useMediaQuery(XL);

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

  const bookFor = (fill: boolean) => (
    <OrderBook
      mode="real"
      market={market}
      base={market.base}
      quote={walletsT("currency")}
      priceDecimals={market.priceDecimals}
      qtyDecimals={market.qtyDecimals}
      fill={fill}
    />
  );
  const book = bookFor(false);

  const orderForm = (
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
        // What the user sees: from lg the depth panel shows Book unless the tab is Trades.
        const visible = wide ? depthTab : tab;
        setTab(tabAfterOrder(visible));
      }}
      // A resting limit order filled nothing: refresh the lists, leave the tabs where they are.
      onRested={() => {
        void account.reload();
        void reloadWallets();
      }}
    />
  );
  const accountPanel = (
    <AccountPanel
      markets={markets}
      orders={account.orders}
      holdings={account.holdings}
      openOrders={account.openOrders}
      onCancel={async (id) => {
        const failure = await cancelOrder(id);
        void account.reload();
        void reloadWallets();
        return failure;
      }}
      error={account.error}
    />
  );

  // From xl the shared desktop layout replaces everything below (the <dl> included).
  if (desktop) {
    return (
      <>
        <DesktopTerminal
          strip={
            <CryptoStrip
              market={market}
              ticker={ticker}
              now={now}
              picker={<MarketPicker market={market} ticker={ticker} onPick={pick} showChange={false} />}
            />
          }
          chart={<TradingViewChart key={market.id} symbol={market.tvSymbol} className="h-full rounded-none border-0 lg:h-full" />}
          book={<DepthTabs
              fill
              tab={depthTab}
              onTabChange={setTab}
              book={bookFor(true)}
              trades={<TradesPanel market={market} />}
            />}
          trading={orderForm}
          bottom={
            <section>
              <h2 className="mb-3 border-b pb-2 text-sm font-semibold">{t("tabs.orders")}</h2>
              {accountPanel}
            </section>
          }
        />
        <SupportFab />
      </>
    );
  }

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
          <dt className="text-muted-foreground">{t("stats.volume", { quote: walletsT("currency") })}</dt>
          <dd>{ticker ? compact.format(toSortNumber(ticker.quoteVolume)) : "--"}</dd>
        </div>
      </dl>

      {/* md: chart and form side by side. lg: the book is a right-hand column and the form sits under the chart. */}
      <div className="space-y-4 md:grid md:grid-cols-[minmax(0,1fr)_340px] md:gap-6 md:space-y-0 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 lg:col-start-1 lg:row-start-1">
          <TradingViewChart key={market.id} symbol={market.tvSymbol} />
        </div>
        <div className="lg:col-start-1 lg:row-start-2">
          {orderForm}
        </div>
        {wide ? (
          <aside className="min-w-0 lg:col-start-2 lg:row-span-2 lg:row-start-1">
            <DepthTabs tab={depthTab} onTabChange={setTab} book={book} trades={<TradesPanel market={market} />} />
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
        {wide || tab === "orders" ? accountPanel : null}
      </section>
      <SupportFab />
    </div>
  );
}
