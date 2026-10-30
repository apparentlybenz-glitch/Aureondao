"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

// Positions and History tabs in their empty state, laid out like PositionsPanel.
export function ForexPositions() {
  const t = useTranslations("Forex");
  const [tab, setTab] = useState<"positions" | "history">("positions");
  const [currentOnly, setCurrentOnly] = useState(false);

  return (
    <section className="mt-6">
      <div role="tablist" className="mb-3 flex gap-5 border-b text-sm">
        {(["positions", "history"] as const).map((key) => (
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
            {key === "positions" ? t("tabs.positions", { count: 0 }) : t("tabs.history")}
          </button>
        ))}
      </div>
      <label className="mb-3 flex w-fit items-center gap-2 text-sm text-muted-foreground">
        <input
          type="checkbox"
          checked={currentOnly}
          onChange={(e) => setCurrentOnly(e.target.checked)}
          className="size-4 accent-primary"
        />
        {t("currentOnly")}
      </label>
      <p className="py-6 text-center text-sm text-muted-foreground">
        {tab === "positions" ? t("noOpen") : t("noHistory")}
      </p>
    </section>
  );
}
