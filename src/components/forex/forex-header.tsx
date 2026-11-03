"use client";

import { useState } from "react";
import { BookOpen, ChevronDown, Info } from "lucide-react";
import { useTranslations } from "next-intl";
import { Sheet } from "@/components/app/sheet";
import { ForexIcon } from "@/components/forex/forex-icon";
import { durationParts, fxDisplay } from "@/lib/forex-math";
import type { FxInstrument } from "@/lib/forex";
import type { OptionPeriod } from "@/lib/options";
import { bpsToPercent } from "@/lib/options-math";
import { cn } from "@/lib/utils";

const SHEET = "max-h-[80dvh] pb-[calc(1rem+var(--safe-b))]";
const ICON = "flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground";

// The instrument button and the sheet it opens. Shared by the header and the desktop strip.
export function ForexPairPicker({
  instrument,
  instruments,
  onPick,
}: {
  instrument: FxInstrument;
  instruments: readonly FxInstrument[];
  onPick: (id: string) => void;
}) {
  const t = useTranslations("Forex");
  const [pickerOpen, setPickerOpen] = useState(false);
  return (
    <Sheet
      open={pickerOpen}
      onOpenChange={setPickerOpen}
      title={t("pairsTitle")}
      closeLabel={t("close")}
      className={SHEET}
      trigger={
        <button
          type="button"
          aria-label={t("choosePair", { symbol: fxDisplay(instrument.id) })}
          className="flex min-w-0 items-center gap-1.5"
        >
          <ForexIcon id={instrument.id} />
          <span className="text-lg font-semibold">{fxDisplay(instrument.id)}</span>
          <ChevronDown className="size-4 text-muted-foreground" />
        </button>
      }
    >
      <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2">
        {instruments.map((i) => (
          <li key={i.id}>
            <button
              type="button"
              aria-pressed={i.id === instrument.id}
              onClick={() => {
                onPick(i.id);
                setPickerOpen(false);
              }}
              className={cn(
                "flex h-12 w-full items-center gap-2 rounded-lg px-3 text-left font-medium",
                i.id === instrument.id ? "bg-muted text-primary" : "",
              )}
            >
              <ForexIcon id={i.id} surface="popover" />
              {fxDisplay(i.id)}
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

// The info button and the sheet it opens: durations, rates, fee and the entry and settlement rules.
export function ForexInfo({ periods }: { periods: OptionPeriod[] | null }) {
  const t = useTranslations("Forex");
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
            {enabled.map((p) => {
              const d = durationParts(p.durationS);
              return (
                <li key={p.durationS} className="flex justify-between px-3 py-2.5 tabular-nums">
                  <span>{t(d.unit, { value: d.value })}</span>
                  <span className="text-up">{t("infoRate", { rate: bpsToPercent(p.profitRateBps) })}</span>
                </li>
              );
            })}
          </ul>
        )}
        {enabled[0] ? <p>{t("infoFee", { rate: bpsToPercent(enabled[0].feeBps) })}</p> : null}
        <p>{t("infoEntry")}</p>
        <p className="text-muted-foreground">{t("infoSettle")}</p>
      </div>
    </Sheet>
  );
}

// Last price with the 24 hour change beneath, under the picker (below xl).
export function ForexPriceBlock({
  price,
  change,
  tone,
}: {
  price: string;
  change: string;
  tone: "up" | "down" | undefined;
}) {
  return (
    <div>
      <p
        className={cn(
          "text-2xl leading-tight font-semibold tabular-nums",
          tone === "up" && "text-up",
          tone === "down" && "text-down",
        )}
      >
        {price}
      </p>
      <p className={cn("text-xs tabular-nums", tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-muted-foreground")}>
        {change}
      </p>
    </div>
  );
}

// Instrument picker, info and the order book toggle (below lg), then the last price.
export function ForexHeader({
  instrument,
  instruments,
  periods,
  bookShown,
  price,
  change,
  tone,
  onPick,
  onToggleBook,
}: {
  instrument: FxInstrument;
  instruments: readonly FxInstrument[];
  periods: OptionPeriod[] | null;
  bookShown: boolean;
  price: string;
  change: string;
  tone: "up" | "down" | undefined;
  onPick: (id: string) => void;
  onToggleBook: () => void;
}) {
  const t = useTranslations("Forex");

  return (
    <header className="mb-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1">
          <ForexPairPicker instrument={instrument} instruments={instruments} onPick={onPick} />
          <ForexInfo periods={periods} />
        </div>
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
      <ForexPriceBlock price={price} change={change} tone={tone} />
    </header>
  );
}
