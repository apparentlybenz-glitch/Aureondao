"use client";

import { useTranslations } from "next-intl";
import { BOOK_POLL_MS, BOOK_TIMEOUT_MS, normalizeVisionTrades, visionTradesUrl } from "@/lib/market/book";
import { formatPrice } from "@/lib/market/decimal";
import { getJson } from "@/lib/market/http";
import type { Market } from "@/lib/market/types";
import { usePoll } from "@/lib/market/use-poll";
import { cn } from "@/lib/utils";

// Real exchange trades from Vision for the selected symbol only, polled every
// 5 s while the tab is mounted and the page is visible. No fallback: if Vision
// fails this shows an unavailable state. Display only. The book is OrderBook.
const browserFetch = (url: string, init: { signal: AbortSignal }) => fetch(url, init);
const every5s = () => BOOK_POLL_MS;

const timeFormat = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

function Note() {
  const t = useTranslations("Spot");
  return <p className="pt-2 text-[11px] text-muted-foreground">{t("bookNote")}</p>;
}

export function TradesPanel({ market }: { market: Market }) {
  const t = useTranslations("Spot");
  const w = useTranslations("Wallets");
  const trades = usePoll(
    `trades|${market.id}`,
    async () => normalizeVisionTrades(await getJson(browserFetch, visionTradesUrl(market), BOOK_TIMEOUT_MS)),
    every5s,
  );

  return (
    <div>
      <div className="grid grid-cols-3 pb-1 text-xs text-muted-foreground">
        <span>{t("columns.time")}</span>
        <span className="text-right">{t("columns.price", { quote: w("currency") })}</span>
        <span className="text-right">{t("columns.amount", { base: market.base })}</span>
      </div>
      {trades.data ? (
        <ul>
          {trades.data.map((tr) => (
            <li key={tr.id} className="grid grid-cols-3 py-0.5 text-[13px] tabular-nums">
              <span className="text-muted-foreground">{timeFormat.format(tr.time)}</span>
              <span className={cn("text-right", tr.side === "buy" ? "text-up" : "text-down")}>
                {formatPrice(tr.price, market.priceDecimals)}
              </span>
              <span className="text-right">{formatPrice(tr.qty, market.qtyDecimals)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {trades.failing ? t("tradesUnavailable") : t("loading")}
        </p>
      )}
      <Note />
    </div>
  );
}
