"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ForexPair } from "@/lib/forex-pairs";

// Inert placeholder ticket in the Options ticket's position: no submit
// handler, no wallet access, no writes. The pricing session wires it up.
export function ForexTicket({ pair, mid }: { pair: ForexPair; mid: string }) {
  const t = useTranslations("Forex");

  return (
    <form onSubmit={(e) => e.preventDefault()} className="space-y-4">
      <p className="text-xs text-muted-foreground">
        {t.rich("currentPrice", {
          symbol: pair.display,
          price: mid,
          value: (chunks) => <span className="tabular-nums text-foreground">{chunks}</span>,
        })}
      </p>

      <div className="grid grid-cols-2 gap-3">
        <Button type="button" disabled className="h-12 bg-up text-base font-semibold text-black">
          {t("buy")}
        </Button>
        <Button type="button" disabled className="h-12 bg-down/60 text-base font-semibold text-white">
          {t("sell")}
        </Button>
      </div>

      <div className="space-y-2">
        <p className="font-medium">{t("amount")}</p>
        <Input
          data-fab-avoid=""
          disabled
          inputMode="decimal"
          autoComplete="off"
          aria-label={t("amountInput")}
          placeholder={t("amountPlaceholder")}
          className="h-11 text-base tabular-nums"
        />
      </div>

      <p data-fab-avoid="" className="text-sm text-muted-foreground">
        {t("notAvailable")}
      </p>
    </form>
  );
}
