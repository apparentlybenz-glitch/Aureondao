"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

// The book, with a Trades tab beside it when the instrument has real trades (crypto).
// Used for the right-hand column from lg up and for the section below the form otherwise.
export function DepthTabs({ book, trades }: { book: ReactNode; trades?: ReactNode }) {
  const t = useTranslations("Spot");
  const [tab, setTab] = useState<"book" | "trades">("book");
  if (!trades) {
    return (
      <section>
        <h2 className="mb-3 border-b pb-2 text-sm font-semibold">{t("tabs.book")}</h2>
        {book}
      </section>
    );
  }
  return (
    <section>
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
      {tab === "book" ? book : trades}
    </section>
  );
}
