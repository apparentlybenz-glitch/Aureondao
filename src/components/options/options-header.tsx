"use client";

import { useState } from "react";
import { BookOpen, ChevronDown, Info } from "lucide-react";
import { useTranslations } from "next-intl";
import { Sheet } from "@/components/app/sheet";
import { bpsToPercent } from "@/lib/options-math";
import type { OptionPeriod } from "@/lib/options";
import { CoinIcon } from "@/components/market/coin-icon";
import type { Market } from "@/lib/market/types";
import { cn } from "@/lib/utils";

const SHEET = "max-h-[80dvh] pb-[calc(1rem+var(--safe-b))]";

const ICON = "flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground";

// The symbol button and the markets sheet it opens. Shared by the header and the desktop strip.
export function OptionsMarketPicker({
  market,
  markets,
  onPick,
}: {
  market: Market;
  markets: Market[];
  onPick: (id: string) => void;
}) {
  const t = useTranslations("Options");
  const [pickerOpen, setPickerOpen] = useState(false);
  return (
    <Sheet
      open={pickerOpen}
      onOpenChange={setPickerOpen}
      title={t("marketsTitle")}
      closeLabel={t("close")}
      className={SHEET}
      trigger={
        <button
          type="button"
          aria-label={t("chooseMarket", { symbol: market.displaySymbol })}
          className="flex min-w-0 items-center gap-1.5"
        >
          <CoinIcon symbol={market.base} size={28} />
          <span className="text-lg font-semibold">{market.displaySymbol}</span>
          <ChevronDown className="size-4 text-muted-foreground" />
        </button>
      }
    >
      <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2">
        {markets.map((m) => (
          <li key={m.id}>
            <button
              type="button"
              aria-pressed={m.id === market.id}
              onClick={() => {
                onPick(m.id);
                setPickerOpen(false);
              }}
              className={cn(
                "flex h-12 w-full items-center gap-2.5 rounded-lg px-3 text-left font-medium",
                m.id === market.id ? "bg-muted text-primary-text" : "",
              )}
            >
              <CoinIcon symbol={m.base} size={24} />
              {m.displaySymbol}
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

// The info button and the periods sheet it opens (periods, rates, fee).
export function OptionsInfo({ periods }: { periods: OptionPeriod[] | null }) {
  const t = useTranslations("Options");
  const enabled = periods?.filter((p) => p.enabled) ?? [];
  const [open, setOpen] = useState(false);
  return (
    <Sheet
      open={open}
      onOpenChange={setOpen}
      title={t("infoTitle")}
      closeLabel={t("close")}
      className={SHEET}
      trigger={
        <button type="button" aria-label={t("info")} className={ICON}>
          <Info className="size-5" />
        </button>
      }
    >
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 text-sm">
        {enabled.length === 0 ? (
          <p className="text-muted-foreground">{t("infoEmpty")}</p>
        ) : (
          <ul className="divide-y rounded-xl border">
            {enabled.map((p) => (
              <li key={p.durationS} className="flex justify-between px-3 py-2.5 tabular-nums">
                <span>{t("seconds", { seconds: p.durationS })}</span>
                <span className="text-up">{t("infoRate", { rate: bpsToPercent(p.profitRateBps) })}</span>
              </li>
            ))}
          </ul>
        )}
        {enabled[0] ? <p>{t("infoFee", { rate: bpsToPercent(enabled[0].feeBps) })}</p> : null}
        <p className="text-muted-foreground">{t("infoSettle")}</p>
      </div>
    </Sheet>
  );
}

// Symbol (opens the options markets), info (periods, rates, fee), order book toggle (below lg).
export function OptionsHeader({
  market,
  markets,
  periods,
  bookShown,
  onPick,
  onToggleBook,
}: {
  market: Market;
  markets: Market[];
  periods: OptionPeriod[] | null;
  bookShown: boolean;
  onPick: (id: string) => void;
  onToggleBook: () => void;
}) {
  const t = useTranslations("Options");

  return (
    <header className="mb-3 flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-1">
        <OptionsMarketPicker market={market} markets={markets} onPick={onPick} />
        <OptionsInfo periods={periods} />
      </div>

      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-pressed={bookShown}
          aria-label={bookShown ? t("hideBook") : t("showBook")}
          onClick={onToggleBook}
          className={cn(ICON, "lg:hidden", bookShown && "text-primary-text")}
        >
          <BookOpen className="size-5" />
        </button>
      </div>
    </header>
  );
}
