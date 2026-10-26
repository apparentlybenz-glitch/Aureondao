"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";
import type { CandlestickData, IChartApi, ISeriesApi, UTCTimestamp } from "lightweight-charts";
import { INTERVAL_MS, klinesRefreshDelay, loadKlines } from "@/lib/market/klines";
import type { Candle, Interval } from "@/lib/market/klines";
import type { Market, Ticker } from "@/lib/market/types";
import { usePoll } from "@/lib/market/use-poll";
import { cn } from "@/lib/utils";

const MAIN: Interval[] = ["1m", "5m", "15m", "30m", "1h", "4h"];
const MORE: Interval[] = ["1d", "1w"];
const LABEL: Record<Interval, string> = {
  "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1h", "4h": "4h", "1d": "1D", "1w": "1W",
};

// The chart library draws with numbers. Display only: no money path reads them.
const toBar = (c: Candle): CandlestickData<UTCTimestamp> => ({
  time: c.time as UTCTimestamp,
  open: Number(c.open),
  high: Number(c.high),
  low: Number(c.low),
  close: Number(c.close),
});

const browserFetch = (url: string, init: { signal: AbortSignal }) => fetch(url, init);

// Candles from Vision (fallback /md/v1/klines), refreshed just after each candle
// closes, with the live candle patched from the ticker store between refreshes.
// Lightweight Charts keeps its attribution logo (O15).
export function PriceChart({ market, ticker }: { market: Market; ticker: Ticker | undefined }) {
  const t = useTranslations("Spot");
  const [interval, setTimeframe] = useState<Interval>("15m");
  const [moreOpen, setMoreOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lastBar = useRef<CandlestickData<UTCTimestamp> | null>(null);
  const shownKey = useRef<string | null>(null);
  const [ready, setReady] = useState(false);

  const key = `${market.id}|${interval}`;
  const klines = usePoll(
    key,
    () => loadKlines(browserFetch, market, interval),
    () => klinesRefreshDelay(interval, Date.now(), Math.random()),
  );

  // Create the chart once; the library is loaded only on this screen.
  useEffect(() => {
    let disposed = false;
    void import("lightweight-charts").then(({ createChart, CandlestickSeries, ColorType }) => {
      if (disposed || !container.current) return;
      const css = getComputedStyle(document.documentElement);
      const up = css.getPropertyValue("--up").trim() || "#3dd68c";
      const down = css.getPropertyValue("--down").trim() || "#f0505a";
      const c = createChart(container.current, {
        autoSize: true,
        layout: {
          background: { type: ColorType.Solid, color: "transparent" },
          textColor: "#8a8f98",
          attributionLogo: true,
        },
        grid: { vertLines: { color: "rgba(255,255,255,0.04)" }, horzLines: { color: "rgba(255,255,255,0.04)" } },
        rightPriceScale: { borderVisible: false },
        timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      });
      series.current = c.addSeries(CandlestickSeries, {
        upColor: up,
        downColor: down,
        wickUpColor: up,
        wickDownColor: down,
        borderVisible: false,
      });
      chart.current = c;
      setReady(true);
    });
    return () => {
      disposed = true;
      chart.current?.remove();
      chart.current = null;
      series.current = null;
    };
  }, []);

  useEffect(() => {
    series.current?.applyOptions({
      priceFormat: { type: "price", precision: market.priceDecimals, minMove: 1 / 10 ** market.priceDecimals },
    });
  }, [market.priceDecimals, ready]);

  useEffect(() => {
    const candles = klines.data?.candles;
    if (!ready || !series.current || !candles) return;
    const bars = candles.map(toBar);
    series.current.setData(bars);
    lastBar.current = bars.at(-1) ?? null;
    if (shownKey.current !== key) {
      shownKey.current = key;
      chart.current?.timeScale().scrollToRealTime();
    }
  }, [klines.data, ready, key]);

  // Patch the open candle from the ticker's last price while it is in that candle.
  useEffect(() => {
    const bar = lastBar.current;
    if (!ticker || !bar || !series.current) return;
    const start = (bar.time as number) * 1000;
    if (ticker.ts < start || ticker.ts >= start + INTERVAL_MS[interval]) return;
    const close = Number(ticker.last);
    const next = { ...bar, close, high: Math.max(bar.high, close), low: Math.min(bar.low, close) };
    series.current.update(next);
    lastBar.current = next;
  }, [ticker, interval]);

  const pick = (next: Interval) => {
    setTimeframe(next);
    setMoreOpen(false);
  };
  const moreActive = MORE.includes(interval);

  return (
    <section className="space-y-2">
      <div role="toolbar" aria-label={t("timeframe")} className="relative flex items-center gap-1 text-xs">
        {MAIN.map((iv) => (
          <button
            key={iv}
            type="button"
            aria-pressed={interval === iv}
            onClick={() => pick(iv)}
            className={cn(
              "h-7 rounded-md px-2 tabular-nums",
              interval === iv ? "bg-muted font-semibold text-foreground" : "text-muted-foreground",
            )}
          >
            {LABEL[iv]}
          </button>
        ))}
        <button
          type="button"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((o) => !o)}
          className={cn(
            "flex h-7 items-center gap-0.5 rounded-md px-2",
            moreActive ? "bg-muted font-semibold text-foreground" : "text-muted-foreground",
          )}
        >
          {moreActive ? LABEL[interval] : t("more")}
          <ChevronDown className="size-3" />
        </button>
        {moreOpen ? (
          <div className="absolute top-8 right-0 z-10 flex gap-1 rounded-lg border bg-popover p-1 shadow-lg">
            {MORE.map((iv) => (
              <button
                key={iv}
                type="button"
                aria-pressed={interval === iv}
                onClick={() => pick(iv)}
                className={cn("h-8 rounded-md px-3", interval === iv ? "bg-muted font-semibold" : "text-muted-foreground")}
              >
                {LABEL[iv]}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div className="relative h-[280px] md:h-[420px]">
        <div ref={container} className="absolute inset-0" />
        {!klines.data ? (
          <p className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            {klines.failing ? t("chartUnavailable") : t("chartLoading")}
          </p>
        ) : null}
      </div>
    </section>
  );
}
