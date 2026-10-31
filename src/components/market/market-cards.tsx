"use client";

import Link from "next/link";
import { useState } from "react";
import { formatChange, formatPrice } from "@/lib/market/decimal";
import { isDelayed } from "@/lib/market/types";
import type { Ticker } from "@/lib/market/types";
import { useMarketData } from "@/lib/market/use-market-data";
import { cn } from "@/lib/utils";

const CARD_IDS = ["BTC-USDT", "ETH-USDT", "SOL-USDT"] as const;
const MAX_POINTS = 60;
const W = 48;
const H = 20;

// Last prices seen from the shared market store's poll, in memory for this
// page view. No request of its own: a point is added when a new ticker lands.
function useLastHistory(tickers: Readonly<Record<string, Ticker>>) {
  const [seen, setSeen] = useState(tickers);
  const [history, setHistory] = useState<Record<string, { ts: number; v: number }[]>>({});
  if (seen !== tickers) {
    setSeen(tickers);
    const next = { ...history };
    for (const id of CARD_IDS) {
      const t = tickers[id];
      const v = t ? Number(t.last) : NaN;
      const list = history[id] ?? [];
      if (!t || !Number.isFinite(v) || list.at(-1)?.ts === t.ts) continue;
      next[id] = [...list, { ts: t.ts, v }].slice(-MAX_POINTS);
    }
    setHistory(next);
  }
  return history;
}

function Sparkline({ values, className }: { values: number[]; className: string }) {
  const min = Math.min(...values);
  const span = Math.max(...values) - min;
  const points = values
    .map((v, i) => `${((i / (values.length - 1)) * W).toFixed(1)},${(span === 0 ? H / 2 : H - 1 - ((v - min) / span) * (H - 2)).toFixed(1)}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} aria-hidden="true" className="h-5 w-12 shrink-0">
      <polyline points={points} fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} />
    </svg>
  );
}

// Three cards in one row: ticker and sparkline, then price and 24 h change.
export function MarketCards() {
  const { markets, tickers, now } = useMarketData();
  const history = useLastHistory(tickers);

  return (
    <section className="grid grid-cols-3 gap-2">
      {CARD_IDS.map((id) => {
        const market = markets?.find((m) => m.id === id);
        const ticker = tickers[id];
        if (!market || !ticker) {
          return <div key={id} aria-hidden="true" className="h-[4.5rem] animate-pulse rounded-xl bg-muted" />;
        }
        const live = !isDelayed(ticker.ts, now);
        const change = formatChange(ticker.changePct);
        const up = change.startsWith("+");
        const down = change.startsWith("-");
        const values = (history[id] ?? []).map((p) => p.v);
        return (
          <Link
            key={id}
            href={`/spot?symbol=${id}`}
            className="flex min-w-0 flex-col gap-1.5 rounded-xl bg-muted p-2.5"
          >
            <span className="flex items-center justify-between gap-1">
              <span className="text-sm font-semibold">{market.base}</span>
              {live && values.length > 1 ? <Sparkline values={values} className={down ? "stroke-down" : "stroke-up"} /> : null}
            </span>
            <span className="flex flex-wrap items-baseline gap-x-1.5">
              <span className="text-sm font-medium tabular-nums">
                {live ? formatPrice(ticker.last, market.priceDecimals) : "--"}
              </span>
              <span className={cn("text-[11px] tabular-nums", live && up ? "text-up" : live && down ? "text-down" : "text-muted-foreground")}>
                {live ? change : "--"}
              </span>
            </span>
          </Link>
        );
      })}
    </section>
  );
}
