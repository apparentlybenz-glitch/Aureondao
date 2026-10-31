"use client";

import { useState } from "react";
import { BookOpen, ChevronDown, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useTranslations } from "next-intl";
import type { ForexPair } from "@/lib/forex-pairs";
import { cn } from "@/lib/utils";

const sheet =
  "fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[80vh] max-w-[880px] flex-col rounded-t-2xl border-t bg-background pb-[calc(1rem+var(--safe-b))]";

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
  const shell = useTranslations("Shell");
  const [pickerOpen, setPickerOpen] = useState(false);
  const icon = "flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground";

  return (
    <header className="mb-3 flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-1">
        <Dialog.Root open={pickerOpen} onOpenChange={setPickerOpen}>
          <Dialog.Trigger asChild>
            <button
              type="button"
              aria-label={t("choosePair", { symbol: pair.display })}
              className="flex min-w-0 items-center gap-1.5"
            >
              <PairIcon icon={pair.icon} />
              <span className="text-lg font-semibold">{pair.display}</span>
              <ChevronDown className="size-4 text-muted-foreground" />
            </button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
            <Dialog.Content aria-describedby={undefined} className={sheet}>
              <div className="flex items-center justify-between px-4 pt-3 pb-2">
                <Dialog.Title className="text-base font-semibold">{t("pairsTitle")}</Dialog.Title>
                <Dialog.Close aria-label={t("close")} className="flex size-9 items-center justify-center rounded-full">
                  <X className="size-5" />
                </Dialog.Close>
              </div>
              <ul className="px-2">
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
