"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ArrowDownToLine,
  ArrowRightLeft,
  CandlestickChart,
  Coins,
  Eye,
  EyeOff,
  LifeBuoy,
  ReceiptText,
  Timer,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { MarketTable } from "@/components/market/market-table";
import { formatCents } from "@/lib/money";
import { useSuspension } from "@/lib/suspension";
import { totalCents, useWallets } from "@/lib/wallets";

// Tiles without an href are not built yet; they show "Soon".
const ACTIONS = [
  { key: "deposit", Icon: ArrowDownToLine, href: "/assets/deposit" },
  { key: "options", Icon: Timer, href: "/options" },
  { key: "forex", Icon: Coins, href: "/forex" },
  { key: "spot", Icon: CandlestickChart, href: "/spot" },
  { key: "transfer", Icon: ArrowRightLeft, href: "/assets/transfer" },
  { key: "support", Icon: LifeBuoy, href: "/support" },
  { key: "bills", Icon: ReceiptText, href: "/assets/bills" },
] as const;

export default function HomePage() {
  const t = useTranslations("Home");
  const c = useTranslations("Common");
  const w = useTranslations("Wallets");
  const { wallets } = useWallets();
  const suspension = useSuspension();
  const [hidden, setHidden] = useState(false);

  return (
    <div className="space-y-6">
      {suspension?.suspended ? (
        <div role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm">
          <p className="font-medium">{t("suspended")}</p>
        </div>
      ) : null}

      <section className="space-y-1">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {t("totalLabel")}
          <button
            type="button"
            onClick={() => setHidden((h) => !h)}
            aria-label={hidden ? t("showAmounts") : t("hideAmounts")}
            className="flex size-8 items-center justify-center rounded-full"
          >
            {hidden ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
        <p className="text-3xl font-semibold tabular-nums">
          {wallets ? (hidden ? t("hidden") : formatCents(totalCents(wallets))) : c("loading")}
          <span className="ml-1.5 text-base font-normal text-muted-foreground">{w("currency")}</span>
        </p>
      </section>

      <section className="grid grid-cols-4 gap-y-4">
        {ACTIONS.map((action) => {
          const { key, Icon } = action;
          const body = (
            <>
              <span className="relative flex size-12 items-center justify-center rounded-full bg-muted">
                <Icon className="size-5 text-primary" />
                {"href" in action ? null : (
                  <span className="absolute -top-1 -right-2 rounded-full bg-secondary px-1.5 text-[9px] font-semibold text-muted-foreground ring-1 ring-border">
                    {c("soon")}
                  </span>
                )}
              </span>
              <span className="text-xs">{t(`actions.${key}`)}</span>
            </>
          );
          return "href" in action ? (
            <Link key={key} href={action.href} className="flex flex-col items-center gap-1.5">
              {body}
            </Link>
          ) : (
            <div key={key} aria-disabled="true" className="flex flex-col items-center gap-1.5 opacity-50">
              {body}
            </div>
          );
        })}
      </section>

      <MarketTable variant="home" />
    </div>
  );
}
