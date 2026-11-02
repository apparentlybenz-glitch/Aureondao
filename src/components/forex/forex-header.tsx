"use client";

import { useState } from "react";
import { BookOpen, ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { Sheet } from "@/components/app/sheet";
import type { ForexPair } from "@/lib/forex-pairs";
import { cn } from "@/lib/utils";

// Placeholder icon: a plain circle with the pair's initials.
export function PairIcon({ icon, className }: { icon: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground",
        className,
      )}
    >
      {icon}
    </span>
  );
}

// The pair button and the pairs sheet it opens. Shared by the header and the desktop strip.
export function ForexPairPicker({
  pair,
  pairs,
  onPick,
}: {
  pair: ForexPair;
  pairs: readonly ForexPair[];
  onPick: (symbol: string) => void;
}) {
  const t = useTranslations("Forex");
  const [pickerOpen, setPickerOpen] = useState(false);
  return (
    <Sheet
      open={pickerOpen}
      onOpenChange={setPickerOpen}
      title={t("pairsTitle")}
      closeLabel={t("close")}
      className="max-h-[80dvh] pb-[calc(1rem+var(--safe-b))]"
      trigger={
        <button
          type="button"
          aria-label={t("choosePair", { symbol: pair.display })}
          className="flex min-w-0 items-center gap-1.5"
        >
          <PairIcon icon={pair.icon} />
          <span className="text-lg font-semibold">{pair.display}</span>
          <ChevronDown className="size-4 text-muted-foreground" />
        </button>
      }
    >
      <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2">
        {pairs.map((p) => (
          <li key={p.symbol}>
            <button
              type="button"
              aria-pressed={p.symbol === pair.symbol}
              onClick={() => {
                onPick(p.symbol);
                setPickerOpen(false);
              }}
              className={cn(
                "flex h-12 w-full items-center gap-2 rounded-lg px-3 text-left font-medium",
                p.symbol === pair.symbol ? "bg-muted text-primary" : "",
              )}
            >
              <PairIcon icon={p.icon} />
              {p.display}
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

// Pair picker and order book toggle (below lg), copied from OptionsHeader.
export function ForexHeader({
  pair,
  pairs,
  bookShown,
  onPick,
  onToggleBook,
}: {
  pair: ForexPair;
  pairs: readonly ForexPair[];
  bookShown: boolean;
  onPick: (symbol: string) => void;
  onToggleBook: () => void;
}) {
  const t = useTranslations("Forex");
  const icon = "flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground";

  return (
    <header className="mb-3 flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-1">
        <ForexPairPicker pair={pair} pairs={pairs} onPick={onPick} />
      </div>

      <div className="flex items-center gap-1">
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
