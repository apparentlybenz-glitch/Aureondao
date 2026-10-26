"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { SupportFab } from "@/components/app/support-fab";
import { PriceChart } from "@/components/spot/price-chart";
import { isPositiveDecimal } from "@/lib/market/decimal";
import { useMarketData } from "@/lib/market/use-market-data";
import { readChartShown, saveChartShown, useOptionPeriods, useOptionPositions } from "@/lib/options";
import { useServerClockSync } from "@/lib/server-clock";
import { usePriceFeedDemand } from "@/lib/spot";
import { midPrice } from "@/lib/spot-math";
import { cn } from "@/lib/utils";
import { useWallets } from "@/lib/wallets";
import { OptionTicket } from "./option-ticket";
import { OptionsHeader } from "./options-header";
import { PositionsPanel } from "./positions-panel";

const DEFAULT_MARKET = "BTC-USDT";

// /options: header, chart (can be hidden), ticket, then Positions / Fill.
// Phone first; from md: the chart and the ticket sit side by side, like Spot.
export function OptionsTerminal() {
  const m = useTranslations("Market");
  const { markets, tickers } = useMarketData();
  const { wallets } = useWallets();
  const periods = useOptionPeriods();
  const positions = useOptionPositions();
  const [symbol, setSymbol] = useState(DEFAULT_MARKET);
  const [chartShown, setChartShown] = useState(readChartShown);
  usePriceFeedDemand();
  useServerClockSync();

  const optionMarkets = markets?.filter((x) => x.optionsEnabled) ?? [];
  const market = optionMarkets.find((x) => x.id === symbol) ?? optionMarkets[0] ?? null;
  if (!market || !markets) {
    return <p className="px-4 py-10 text-center text-sm text-muted-foreground">{m("loading")}</p>;
  }

  const ticker = tickers[market.id];
  // Display only: the browser's mid of the exchange bid/ask. Never sent anywhere.
  const mid = ticker && isPositiveDecimal(ticker.bid) && isPositiveDecimal(ticker.ask) ? midPrice(ticker.bid, ticker.ask) : null;
  const options = wallets?.find((w) => w.account === "options") ?? null;
  const priceLines = (positions.open ?? [])
    .filter((p) => p.marketId === market.id)
    .map((p) => ({ price: p.entryPrice, tone: p.direction === "rise" ? ("up" as const) : ("down" as const) }));

  function toggleChart() {
    saveChartShown(!chartShown);
    setChartShown(!chartShown);
  }

  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 pt-3 pb-[calc(56px+5rem+env(safe-area-inset-bottom))]">
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
          chartShown && "md:grid md:grid-cols-[minmax(0,1fr)_340px] md:gap-6 md:space-y-0",
          !chartShown && "md:mx-auto md:max-w-[480px]",
        )}
      >
        {chartShown ? <PriceChart market={market} ticker={ticker} priceLines={priceLines} /> : null}
        <OptionTicket
          key={market.id}
          market={market}
          mid={mid}
          periods={periods}
          available={options ? options.available : null}
          onOpened={() => void positions.reload()}
        />
      </div>
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
