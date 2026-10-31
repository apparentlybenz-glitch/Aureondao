"use client";

import { useState } from "react";
import { BookOpen, ChevronDown, Info, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useTranslations } from "next-intl";
import { bpsToPercent } from "@/lib/options-math";
import type { OptionPeriod } from "@/lib/options";
import type { Market } from "@/lib/market/types";
import { cn } from "@/lib/utils";

const sheet =
  "fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[80vh] max-w-[880px] flex-col rounded-t-2xl border-t bg-background pb-[calc(1rem+var(--safe-b))]";

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
  const [pickerOpen, setPickerOpen] = useState(false);
  const enabled = periods?.filter((p) => p.enabled) ?? [];
  const icon = "flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground";

  return (
    <header className="mb-3 flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-1">
        <Dialog.Root open={pickerOpen} onOpenChange={setPickerOpen}>
          <Dialog.Trigger asChild>
            <button
              type="button"
              aria-label={t("chooseMarket", { symbol: market.displaySymbol })}
              className="flex min-w-0 items-center gap-1.5"
            >
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
                        "flex h-12 w-full items-center rounded-lg px-3 text-left font-medium",
                        m.id === market.id ? "bg-muted text-primary" : "",
                      )}
                    >
                      {m.displaySymbol}
                    </button>
                  </li>
                ))}
              </ul>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>

        <Dialog.Root>
          <Dialog.Trigger aria-label={t("info")} className={icon}>
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
          className={cn(icon, "lg:hidden", bookShown && "text-primary")}
        >
          <BookOpen className="size-5" />
        </button>
      </div>
    </header>
  );
}
