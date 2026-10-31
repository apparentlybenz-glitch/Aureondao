"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

// The book, with a Trades tab beside it when the instrument has real trades (crypto).
// Used for the right-hand column from lg up and for the section below the form otherwise.
// `fill` is for the desktop book card: the section takes the card height and the book fills it
// (the trades list scrolls inside it). Off everywhere else.
// The tab is optionally controlled (`tab` with `onTabChange`): a terminal that holds it can switch
// it after an order. Without them the panel keeps its own state and starts on Book.
export type DepthTab = "book" | "trades";

export function DepthTabs({
  book,
  trades,
  fill = false,
  tab: controlled,
  onTabChange,
}: {
  book: ReactNode;
  trades?: ReactNode;
  fill?: boolean;
  tab?: DepthTab;
  onTabChange?: (tab: DepthTab) => void;
}) {
  const t = useTranslations("Spot");
  const [own, setOwn] = useState<DepthTab>("book");
  const tab = controlled ?? own;
  const setTab = onTabChange ?? setOwn;
  const section = fill ? "flex h-full min-h-0 flex-col" : undefined;
  if (!trades) {
    return (
      <section className={section}>
        <h2 className="mb-3 border-b pb-2 text-sm font-semibold">{t("tabs.book")}</h2>
        {book}
      </section>
    );
  }
  return (
    <section className={section}>
      <div role="tablist" className="mb-3 flex gap-5 border-b text-sm">
        {(["book", "trades"] as const).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cn(
              "-mb-px border-b-2 py-2",
              tab === key ? "border-primary font-semibold text-foreground" : "border-transparent text-muted-foreground",
            )}
          >
            {t(`tabs.${key}`)}
          </button>
        ))}
      </div>
      {fill ? (
        <div className={cn("flex min-h-0 flex-1 flex-col", tab === "trades" && "overflow-y-auto")}>
          {tab === "book" ? book : trades}
        </div>
      ) : tab === "book" ? (
        book
      ) : (
        trades
      )}
    </section>
  );
}
