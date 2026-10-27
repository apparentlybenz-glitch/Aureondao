"use client";

import { useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useTranslations } from "next-intl";
import { MarketTable } from "@/components/market/market-table";
import { formatChange } from "@/lib/market/decimal";
import type { Market, Ticker } from "@/lib/market/types";
import { cn } from "@/lib/utils";

// Header symbol button that opens the market list as a bottom sheet (search,
// favorites, live prices: the Market tab's table). Picking a row switches the
// terminal and closes the sheet.
export function MarketPicker({
  market,
  ticker,
  onPick,
}: {
  market: Market;
  ticker: Ticker | undefined;
  onPick: (id: string) => void;
}) {
  const t = useTranslations("Spot");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const change = ticker ? formatChange(ticker.changePct) : null;

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          aria-label={t("chooseMarket", { symbol: market.displaySymbol })}
          className="flex min-w-0 items-center gap-1.5 text-left"
        >
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
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-x-0 top-[8vh] bottom-0 z-50 mx-auto flex max-w-[880px] flex-col rounded-t-2xl border-t bg-background"
        >
          <div className="flex items-center justify-between px-4 pt-3 pb-2">
            <Dialog.Title className="text-base font-semibold">{t("marketsTitle")}</Dialog.Title>
            <Dialog.Close aria-label={t("close")} className="flex size-9 items-center justify-center rounded-full">
              <X className="size-5" />
            </Dialog.Close>
          </div>
          <div className="flex-1 overflow-y-auto px-4 pb-[calc(1rem+var(--safe-b))]">
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
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
