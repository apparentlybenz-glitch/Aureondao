"use client";

import { useState } from "react";
import { BookOpen, ChevronDown, Info, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useTranslations } from "next-intl";
import { bpsToPercent } from "@/lib/options-math";
import type { OptionPeriod } from "@/lib/options";
import { CoinIcon } from "@/components/market/coin-icon";
import type { Market } from "@/lib/market/types";
import { cn } from "@/lib/utils";

const sheet =
  "fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[80vh] max-w-[880px] flex-col rounded-t-2xl border-t bg-background pb-[calc(1rem+var(--safe-b))]";

const ICON = "flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground";

function SheetHeader({ title }: { title: string }) {
  const t = useTranslations("Options");
  return (
    <div className="flex items-center justify-between px-4 pt-3 pb-2">
      <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
      <Dialog.Close aria-label={t("close")} className="flex size-9 items-center justify-center rounded-full">
        <X className="size-5" />
      </Dialog.Close>
    </div>
  );
}

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
    <Dialog.Root open={pickerOpen} onOpenChange={setPickerOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          aria-label={t("chooseMarket", { symbol: market.displaySymbol })}
          className="flex min-w-0 items-center gap-1.5"
        >
          <CoinIcon symbol={market.base} size={28} />
          <span className="text-lg font-semibold">{market.displaySymbol}</span>
          <ChevronDown className="size-4 text-muted-foreground" />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content aria-describedby={undefined} className={sheet}>
          <SheetHeader title={t("marketsTitle")} />
          <ul className="px-2">
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
                    m.id === market.id ? "bg-muted text-primary" : "",
                  )}
                >
                  <CoinIcon symbol={m.base} size={24} />
                  {m.displaySymbol}
                </button>
              </li>
            ))}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// The info button and the periods sheet it opens (periods, rates, fee).
export function OptionsInfo({ periods }: { periods: OptionPeriod[] | null }) {
  const t = useTranslations("Options");
  const enabled = periods?.filter((p) => p.enabled) ?? [];
  return (
    <Dialog.Root>
      <Dialog.Trigger aria-label={t("info")} className={ICON}>
        <Info className="size-5" />
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content aria-describedby={undefined} className={sheet}>
          <SheetHeader title={t("infoTitle")} />
          <div className="space-y-3 px-4 text-sm">
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
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
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
  const shell = useTranslations("Shell");

  return (
    <header className="mb-3 flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-1">
        <OptionsMarketPicker market={market} markets={markets} onPick={onPick} />
        <OptionsInfo periods={periods} />
      </div>

      <div className="flex items-center gap-1">
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground md:hidden">
          {shell("virtualPill")}
        </span>
        <button
          type="button"
          aria-pressed={bookShown}
          aria-label={bookShown ? t("hideBook") : t("showBook")}
          onClick={onToggleBook}
          className={cn(ICON, "lg:hidden", bookShown && "text-primary")}
        >
          <BookOpen className="size-5" />
        </button>
      </div>
    </header>
  );
}
