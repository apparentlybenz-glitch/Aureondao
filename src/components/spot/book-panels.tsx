"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { BOOK_LEVELS, BOOK_POLL_MS, BOOK_TIMEOUT_MS, normalizeVisionDepth, normalizeVisionTrades, visionDepthUrl, visionTradesUrl } from "@/lib/market/book";
import { formatPrice } from "@/lib/market/decimal";
import { getJson } from "@/lib/market/http";
import type { BookLevel } from "@/lib/market/book";
import type { Market } from "@/lib/market/types";
import { midPrice } from "@/lib/spot-math";
import { usePoll } from "@/lib/market/use-poll";
import { cn } from "@/lib/utils";

// Real exchange depth and trades from Vision for the selected symbol only,
// polled every 5 s while the tab is mounted and the page is visible. No
// fallback: if Vision fails these show an unavailable state. Display only.
const browserFetch = (url: string, init: { signal: AbortSignal }) => fetch(url, init);
const every5s = () => BOOK_POLL_MS;

const timeFormat = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

function Note() {
  const t = useTranslations("Spot");
  return <p className="pt-2 text-[11px] text-muted-foreground">{t("bookNote")}</p>;
}

type BookView = "both" | "bids" | "asks";
const BOTH_LEVELS = 10;

// Cumulative quantity per level, best price first, as BigInt units of 1e-18
// (exact; the bar widths are display only).
function cumulative(levels: BookLevel[]): bigint[] {
  let sum = BigInt(0);
  return levels.map((l) => {
    const [whole, fraction = ""] = l.qty.split(".");
    sum += BigInt(whole + fraction.padEnd(18, "0").slice(0, 18));
    return sum;
  });
}

export function OrderBookPanel({ market }: { market: Market }) {
  const t = useTranslations("Spot");
  const [view, setView] = useState<BookView>("both");
  const book = usePoll(
    `depth|${market.id}`,
    async () => normalizeVisionDepth(await getJson(browserFetch, visionDepthUrl(market), BOOK_TIMEOUT_MS)),
    every5s,
  );

  const depth = view === "both" ? BOTH_LEVELS : BOOK_LEVELS;
  const asks = book.data ? book.data.asks.slice(0, depth) : [];
  const bids = book.data ? book.data.bids.slice(0, depth) : [];
  const askCum = cumulative(asks);
  const bidCum = cumulative(bids);
  const shown = [...(view !== "bids" ? askCum : []), ...(view !== "asks" ? bidCum : [])];
  const max = shown.reduce((m, v) => (v > m ? v : m), BigInt(0));
  const width = (cum: bigint) => (max > BigInt(0) ? Number((cum * BigInt(1000)) / max) / 10 : 0);

  const row = (l: BookLevel, cum: bigint, side: "bid" | "ask") => (
    <li key={`${side}${l.price}`} className="relative grid grid-cols-2 py-0.5 text-[13px] tabular-nums">
      <span
        aria-hidden="true"
        className={cn("absolute inset-y-0 right-0", side === "bid" ? "bg-up/15" : "bg-down/15")}
        style={{ width: `${width(cum)}%` }}
      />
      <span className={cn("relative", side === "bid" ? "text-up" : "text-down")}>
        {formatPrice(l.price, market.priceDecimals)}
      </span>
      <span className="relative text-right">{formatPrice(l.qty, market.qtyDecimals)}</span>
    </li>
  );

  const bestBid = book.data?.bids[0];
  const bestAsk = book.data?.asks[0];

  return (
    <div>
      <div role="group" aria-label={t("bookView.label")} className="mb-2 flex gap-2">
        {(["both", "bids", "asks"] as const).map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={view === key}
            onClick={() => setView(key)}
            className={cn(
              "h-7 rounded-md px-2.5 text-xs",
              view === key ? "bg-muted font-semibold text-foreground" : "text-muted-foreground",
            )}
          >
            {t(`bookView.${key}`)}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 pb-1 text-xs text-muted-foreground">
        <span>{t("columns.price", { quote: market.quote })}</span>
        <span className="text-right">{t("columns.amount", { base: market.base })}</span>
      </div>
      {book.data ? (
        <>
          {view !== "bids" ? (
            <ul>{asks.map((l, i) => ({ l, cum: askCum[i] })).reverse().map(({ l, cum }) => row(l, cum, "ask"))}</ul>
          ) : null}
          {view === "both" ? (
            <p className="my-1 flex items-baseline justify-between border-y py-1.5 tabular-nums">
              <span className="text-base font-semibold">
                {bestBid && bestAsk ? formatPrice(midPrice(bestBid.price, bestAsk.price), market.priceDecimals + 1) : "—"}
              </span>
              <span className="text-xs text-muted-foreground">{t("mid")}</span>
            </p>
          ) : null}
          {view !== "asks" ? <ul>{bids.map((l, i) => row(l, bidCum[i], "bid"))}</ul> : null}
        </>
      ) : (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {book.failing ? t("bookUnavailable") : t("loading")}
        </p>
      )}
      <Note />
    </div>
  );
}

export function TradesPanel({ market }: { market: Market }) {
  const t = useTranslations("Spot");
  const trades = usePoll(
    `trades|${market.id}`,
    async () => normalizeVisionTrades(await getJson(browserFetch, visionTradesUrl(market), BOOK_TIMEOUT_MS)),
    every5s,
  );

  return (
    <div>
      <div className="grid grid-cols-3 pb-1 text-xs text-muted-foreground">
        <span>{t("columns.time")}</span>
        <span className="text-right">{t("columns.price", { quote: market.quote })}</span>
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
