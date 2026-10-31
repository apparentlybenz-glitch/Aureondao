"use client";

import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

export type OrderType = "market" | "limit";

// The Market / Limit tab row, drawn inside each ticket (below the Buy and Sell buttons).
export function OrderTypeTabs({ type, onChange }: { type: OrderType; onChange: (type: OrderType) => void }) {
  const t = useTranslations("Spot");
  return (
    <div role="tablist" className="flex gap-4 text-sm">
      {(["market", "limit"] as const).map((key) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={type === key}
          onClick={() => onChange(key)}
          className={cn(
            "border-b-2 py-1",
            type === key ? "border-primary font-semibold" : "border-transparent text-muted-foreground",
          )}
        >
          {t(key)}
        </button>
      ))}
    </div>
  );
}
