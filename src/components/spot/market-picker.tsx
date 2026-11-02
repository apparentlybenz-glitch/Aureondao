"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { Sheet } from "@/components/app/sheet";
import { MarketTable } from "@/components/market/market-table";
import { formatChange } from "@/lib/market/decimal";
import { CoinIcon } from "@/components/market/coin-icon";
import type { Market, Ticker } from "@/lib/market/types";
import { cn } from "@/lib/utils";

// Header symbol button that opens the market list as a bottom sheet (search,
// favorites, live prices: the Market tab's table). Picking a row switches the
// terminal and closes the sheet.
export function MarketPicker({
  market,
  ticker,
  onPick,
  showChange = true,
}: {
  market: Market;
  ticker: Ticker | undefined;
  onPick: (id: string) => void;
  // The desktop strip shows the change under the price, so it hides the badge here.
  showChange?: boolean;
}) {
  const t = useTranslations("Spot");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const change = ticker && showChange ? formatChange(ticker.changePct) : null;

  return (
    <Sheet
      open={open}
      onOpenChange={setOpen}
      title={t("marketsTitle")}
      closeLabel={t("close")}
      className="top-[8dvh]"
      trigger={
        <button
          type="button"
          aria-label={t("chooseMarket", { symbol: market.displaySymbol })}
          className="flex min-w-0 items-center gap-1.5 text-left"
        >
          <CoinIcon symbol={market.base} size={28} />
          <span className="text-lg font-semibold">{market.displaySymbol}</span>
          <ChevronDown className="size-4 text-muted-foreground" />
          {change ? (
            <span
              className={cn(
                "ml-1 rounded-md px-1.5 py-0.5 text-xs font-medium tabular-nums",
                change.startsWith("+") ? "bg-up/15 text-up" : change.startsWith("-") ? "bg-down/15 text-down" : "bg-muted",
              )}
            >
              {change}
            </span>
          ) : null}
        </button>
      }
    >
      <div className="flex-1 overflow-y-auto overscroll-contain px-4 pb-[calc(1rem+var(--safe-b))]">
        <MarketTable
          variant="market"
          query={query}
          onQueryChange={setQuery}
          onSelect={(id) => {
            onPick(id);
            setOpen(false);
          }}
        />
      </div>
    </Sheet>
  );
}
