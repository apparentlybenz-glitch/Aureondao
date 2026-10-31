"use client";

import { useState } from "react";
import { SupportFab } from "@/components/app/support-fab";
import { DepthTabs } from "@/components/market/depth-tabs";
import { OrderBook } from "@/components/market/order-book";
import { TradingViewChart } from "@/components/market/tradingview-chart";
import { FOREX_PAIRS } from "@/lib/forex-pairs";
import { formatPrice } from "@/lib/market/decimal";
import { LG, useMediaQuery } from "@/lib/use-media-query";
import { ForexHeader } from "./forex-header";
import { ForexPositions } from "./forex-positions";
import { ForexTicket } from "./forex-ticket";

// /forex: header, chart, ticket, then Positions / History.
// Layout copied from OptionsTerminal. Placeholder: no prices, orders or wallets. The book is
// a generated ladder around the placeholder mid (no public depth exists for forex); from lg
// it is a right-hand column and the ticket sits under the chart, below lg the header icon
// opens it under the header.
const QTY_DECIMALS = 0;

export function ForexTerminal() {
  const [symbol, setSymbol] = useState(FOREX_PAIRS[0].symbol);
  const [bookShown, setBookShown] = useState(false);
  const pair = FOREX_PAIRS.find((p) => p.symbol === symbol) ?? FOREX_PAIRS[0];
  const wide = useMediaQuery(LG);
  const [base, quote] = pair.display.split("/");
  const depth = (
    <DepthTabs
      book={
        <OrderBook
          mode="generated"
          id={pair.symbol}
          mid={pair.mid}
          base={base}
          quote={quote}
          priceDecimals={pair.priceDecimals}
          qtyDecimals={QTY_DECIMALS}
        />
      }
    />
  );

  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 pt-[calc(0.75rem+var(--safe-t))] pb-[calc(var(--tab-bar-h)+5rem+var(--safe-b))] md:pb-8">
      <ForexHeader
        pair={pair}
        pairs={FOREX_PAIRS}
        bookShown={bookShown}
        onPick={setSymbol}
        onToggleBook={() => setBookShown((s) => !s)}
      />
      {!wide && bookShown ? <div className="mb-4">{depth}</div> : null}
      <div className="space-y-4 md:grid md:grid-cols-[minmax(0,1fr)_340px] md:gap-6 md:space-y-0 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 lg:col-start-1 lg:row-start-1">
          <TradingViewChart key={pair.symbol} symbol={pair.tvSymbol} />
        </div>
        <div className="lg:col-start-1 lg:row-start-2">
          <ForexTicket key={pair.symbol} pair={pair} mid={formatPrice(pair.mid, pair.priceDecimals)} />
        </div>
        {wide ? <aside className="min-w-0 lg:col-start-2 lg:row-span-2 lg:row-start-1">{depth}</aside> : null}
      </div>
      <ForexPositions />
      <SupportFab />
    </div>
  );
}
