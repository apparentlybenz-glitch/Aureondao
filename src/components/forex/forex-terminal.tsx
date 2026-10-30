"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { SupportFab } from "@/components/app/support-fab";
import { DepthTabs } from "@/components/market/depth-tabs";
import { OrderBook } from "@/components/market/order-book";
import { FOREX_PAIRS } from "@/lib/forex-pairs";
import { formatPrice } from "@/lib/market/decimal";
import { LG, useMediaQuery } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";
import { ForexHeader, PairIcon } from "./forex-header";
import { ForexPositions } from "./forex-positions";
import { ForexTicket } from "./forex-ticket";

// /forex: header, chart (can be hidden), ticket, then Positions / History.
// Layout copied from OptionsTerminal. Placeholder: no prices, orders or wallets. The book is
// a generated ladder around the placeholder mid (no public depth exists for forex); from lg,
// with the chart shown, it is a right-hand column and the ticket sits under the chart.
const QTY_DECIMALS = 0;

export function ForexTerminal() {
  const t = useTranslations("Forex");
  const [symbol, setSymbol] = useState(FOREX_PAIRS[0].symbol);
  const [chartShown, setChartShown] = useState(true);
  const pair = FOREX_PAIRS.find((p) => p.symbol === symbol) ?? FOREX_PAIRS[0];
  const wide = useMediaQuery(LG);
  const sideBook = chartShown && wide;
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
        chartShown={chartShown}
        onPick={setSymbol}
        onToggleChart={() => setChartShown((s) => !s)}
      />
      <div
        className={cn(
          "space-y-4",
          chartShown && "md:grid md:grid-cols-[minmax(0,1fr)_340px] md:gap-6 md:space-y-0 lg:grid-cols-[minmax(0,1fr)_320px]",
          !chartShown && "md:mx-auto md:max-w-[480px]",
        )}
      >
        {chartShown ? (
          <div className="flex h-72 flex-col items-center justify-center gap-3 rounded-xl border bg-card md:h-[420px] lg:col-start-1 lg:row-start-1">
            <PairIcon icon={pair.icon} className="size-12 text-base" />
            <p className="text-lg font-semibold">{pair.display}</p>
            <p className="text-sm text-muted-foreground">{pair.name}</p>
            <p className="text-sm text-muted-foreground">{t("chartPlaceholder")}</p>
          </div>
        ) : null}
        <div className="lg:col-start-1 lg:row-start-2">
          <ForexTicket key={pair.symbol} pair={pair} mid={formatPrice(pair.mid, pair.priceDecimals)} />
        </div>
        {sideBook ? <aside className="min-w-0 lg:col-start-2 lg:row-span-2 lg:row-start-1">{depth}</aside> : null}
      </div>
      {!sideBook ? <div className="mx-auto mt-5 max-w-[480px]">{depth}</div> : null}
      <ForexPositions />
      <SupportFab />
    </div>
  );
}
