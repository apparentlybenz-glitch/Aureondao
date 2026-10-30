"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { SupportFab } from "@/components/app/support-fab";
import { FOREX_PAIRS } from "@/lib/forex-pairs";
import { formatPrice } from "@/lib/market/decimal";
import { cn } from "@/lib/utils";
import { ForexHeader, PairIcon } from "./forex-header";
import { ForexPositions } from "./forex-positions";
import { ForexTicket } from "./forex-ticket";

// /forex: header, chart (can be hidden), ticket, then Positions / History.
// Layout copied from OptionsTerminal. Placeholder: no prices, orders or wallets.
export function ForexTerminal() {
  const t = useTranslations("Forex");
  const [symbol, setSymbol] = useState(FOREX_PAIRS[0].symbol);
  const [chartShown, setChartShown] = useState(true);
  const pair = FOREX_PAIRS.find((p) => p.symbol === symbol) ?? FOREX_PAIRS[0];

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
          chartShown && "md:grid md:grid-cols-[minmax(0,1fr)_340px] md:gap-6 md:space-y-0",
          !chartShown && "md:mx-auto md:max-w-[480px]",
        )}
      >
        {chartShown ? (
          <div className="flex h-72 flex-col items-center justify-center gap-3 rounded-xl border bg-card md:h-[420px]">
            <PairIcon icon={pair.icon} className="size-12 text-base" />
            <p className="text-lg font-semibold">{pair.display}</p>
            <p className="text-sm text-muted-foreground">{pair.name}</p>
            <p className="text-sm text-muted-foreground">{t("chartPlaceholder")}</p>
          </div>
        ) : null}
        <ForexTicket key={pair.symbol} pair={pair} mid={formatPrice(pair.mid, pair.priceDecimals)} />
      </div>
      <ForexPositions />
      <SupportFab />
    </div>
  );
}
