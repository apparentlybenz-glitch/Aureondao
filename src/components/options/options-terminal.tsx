"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { SupportFab } from "@/components/app/support-fab";
import { DepthTabs } from "@/components/market/depth-tabs";
import { OrderBook } from "@/components/market/order-book";
import { PriceChart } from "@/components/spot/price-chart";
import { TradesPanel } from "@/components/spot/book-panels";
import { isPositiveDecimal } from "@/lib/market/decimal";
import { isDelayed } from "@/lib/market/types";
import { useMarketData } from "@/lib/market/use-market-data";
import { readChartShown, saveChartShown, useOptionPeriods, useOptionPositions } from "@/lib/options";
import { useServerClockSync } from "@/lib/server-clock";
import { usePriceFeedDemand } from "@/lib/spot";
import { midPrice } from "@/lib/spot-math";
import { LG, useMediaQuery } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";
import { useWallets } from "@/lib/wallets";
import { OptionTicket } from "./option-ticket";
import { OptionsHeader } from "./options-header";
import { PositionsPanel } from "./positions-panel";

const DEFAULT_MARKET = "BTC-USDT";

// /options: header, chart (can be hidden), ticket, then Positions / Fill.
// Phone first; from md: the chart and the ticket sit side by side, like Spot. From lg, with
// the chart shown, the underlying's book is a right-hand column and the ticket sits under the
// chart; otherwise the book is a section under the ticket.
export function OptionsTerminal() {
  const m = useTranslations("Market");
  const { markets, tickers, now } = useMarketData();
  const { wallets } = useWallets();
  const periods = useOptionPeriods();
  const positions = useOptionPositions();
  const [symbol, setSymbol] = useState(DEFAULT_MARKET);
  const [chartShown, setChartShown] = useState(readChartShown);
  usePriceFeedDemand();
  useServerClockSync();
  const wide = useMediaQuery(LG);

  const optionMarkets = markets?.filter((x) => x.optionsEnabled) ?? [];
  const market = optionMarkets.find((x) => x.id === symbol) ?? optionMarkets[0] ?? null;
  if (!market || !markets) {
    return <p className="px-4 py-10 text-center text-sm text-muted-foreground">{m("loading")}</p>;
  }

  const ticker = tickers[market.id];
  // Display only: the browser's mid of the exchange bid/ask. Never sent anywhere.
  // A delayed ticker shows "--", as the Spot header does.
  const mid =
    ticker && !isDelayed(ticker.ts, now) && isPositiveDecimal(ticker.bid) && isPositiveDecimal(ticker.ask)
      ? midPrice(ticker.bid, ticker.ask)
      : null;
  const options = wallets?.find((w) => w.account === "options") ?? null;
  const priceLines = (positions.open ?? [])
    .filter((p) => p.marketId === market.id)
    .map((p) => ({ price: p.entryPrice, tone: p.direction === "rise" ? ("up" as const) : ("down" as const) }));

  const sideBook = chartShown && wide;
  const depth = (
    <DepthTabs
      book={
        <OrderBook
          mode="real"
          market={market}
          base={market.base}
          quote={market.quote}
          priceDecimals={market.priceDecimals}
          qtyDecimals={market.qtyDecimals}
        />
      }
      trades={<TradesPanel market={market} />}
    />
  );

  function toggleChart() {
    saveChartShown(!chartShown);
    setChartShown(!chartShown);
  }

  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 pt-[calc(0.75rem+var(--safe-t))] pb-[calc(var(--tab-bar-h)+5rem+var(--safe-b))] md:pb-8">
      <OptionsHeader
        market={market}
        markets={optionMarkets}
        periods={periods}
        chartShown={chartShown}
        onPick={setSymbol}
        onToggleChart={toggleChart}
      />
      <div
        className={cn(
          "space-y-4",
          chartShown && "md:grid md:grid-cols-[minmax(0,1fr)_340px] md:gap-6 md:space-y-0 lg:grid-cols-[minmax(0,1fr)_320px]",
          !chartShown && "md:mx-auto md:max-w-[480px]",
        )}
      >
        {chartShown ? (
          <div className="min-w-0 lg:col-start-1 lg:row-start-1">
            <PriceChart key={market.id} market={market} ticker={ticker} priceLines={priceLines} />
          </div>
        ) : null}
        <div className="lg:col-start-1 lg:row-start-2">
          <OptionTicket
            key={market.id}
            market={market}
            mid={mid}
            periods={periods}
            available={options ? options.available : null}
            onOpened={() => void positions.reload()}
          />
        </div>
        {sideBook ? <aside className="min-w-0 lg:col-start-2 lg:row-span-2 lg:row-start-1">{depth}</aside> : null}
      </div>
      {!sideBook ? <div className="mx-auto mt-5 max-w-[480px]">{depth}</div> : null}
      <PositionsPanel
        open={positions.open}
        fills={positions.fills}
        error={positions.error}
        markets={markets}
        currentId={market.id}
      />
      <SupportFab />
    </div>
  );
}
