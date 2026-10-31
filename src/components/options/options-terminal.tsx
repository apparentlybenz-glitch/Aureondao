"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { SupportFab } from "@/components/app/support-fab";
import { DepthTabs } from "@/components/market/depth-tabs";
import { OrderBook } from "@/components/market/order-book";
import { TradingViewChart } from "@/components/market/tradingview-chart";
import { TradesPanel } from "@/components/spot/book-panels";
import { isPositiveDecimal } from "@/lib/market/decimal";
import { isDelayed } from "@/lib/market/types";
import { useMarketData } from "@/lib/market/use-market-data";
import { useOptionPeriods, useOptionPositions } from "@/lib/options";
import { useServerClockSync } from "@/lib/server-clock";
import { usePriceFeedDemand } from "@/lib/spot";
import { midPrice } from "@/lib/spot-math";
import { LG, useMediaQuery } from "@/lib/use-media-query";
import { useWallets } from "@/lib/wallets";
import { OptionTicket } from "./option-ticket";
import { OptionsHeader } from "./options-header";
import { PositionsPanel } from "./positions-panel";

const DEFAULT_MARKET = "BTC-USDT";

// /options: header, chart, ticket, then Positions / Fill.
// Phone first; from md: the chart and the ticket sit side by side, like Spot. From lg the
// underlying's book is a right-hand column and the ticket sits under the chart. Below lg the
// book is hidden until the header icon opens it under the header.
export function OptionsTerminal() {
  const m = useTranslations("Market");
  const { markets, tickers, now } = useMarketData();
  const { wallets, reload: reloadWallets } = useWallets();
  const periods = useOptionPeriods();
  const positions = useOptionPositions();
  const [symbol, setSymbol] = useState(DEFAULT_MARKET);
  const [bookShown, setBookShown] = useState(false);
  usePriceFeedDemand();
  useServerClockSync();
  const wide = useMediaQuery(LG);

  // Settle and void change a wallet in the same transaction as the position row,
  // so every positions update after the first load reloads the wallets too. This
  // also covers a missed wallet event (the positions reload at expires_at + 12 s).
  const { open, fills } = positions;
  const positionsLoaded = useRef(false);
  useEffect(() => {
    if (open === null || fills === null) return;
    if (!positionsLoaded.current) {
      positionsLoaded.current = true;
      return;
    }
    void reloadWallets();
  }, [open, fills, reloadWallets]);

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

  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 pt-[calc(0.75rem+var(--safe-t))] pb-[calc(var(--tab-bar-h)+5rem+var(--safe-b))] md:pb-8">
      <OptionsHeader
        market={market}
        markets={optionMarkets}
        periods={periods}
        bookShown={bookShown}
        onPick={setSymbol}
        onToggleBook={() => setBookShown((s) => !s)}
      />
      {!wide && bookShown ? <div className="mb-4">{depth}</div> : null}
      <div className="space-y-4 md:grid md:grid-cols-[minmax(0,1fr)_340px] md:gap-6 md:space-y-0 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 lg:col-start-1 lg:row-start-1">
          <TradingViewChart key={market.id} symbol={market.tvSymbol} />
        </div>
        <div className="lg:col-start-1 lg:row-start-2">
          <OptionTicket
            key={market.id}
            market={market}
            mid={mid}
            periods={periods}
            available={options ? options.available : null}
            onOpened={() => {
              void positions.reload();
              void reloadWallets();
            }}
          />
        </div>
        {wide ? <aside className="min-w-0 lg:col-start-2 lg:row-span-2 lg:row-start-1">{depth}</aside> : null}
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
