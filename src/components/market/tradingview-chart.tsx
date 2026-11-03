"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Skeleton } from "@/components/ui/skeleton";
import { useTheme } from "@/lib/use-theme";
import { cn } from "@/lib/utils";

const SCRIPT = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";

// A CSS color as the browser normalizes it (#rrggbb, or rgba() with alpha), which the widget
// needs; undefined when the token is missing or not a color, so the widget keeps its default.
function toColor(value: string): string | undefined {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx || !value.trim()) return undefined;
  ctx.fillStyle = "#000000";
  ctx.fillStyle = value.trim();
  const first = ctx.fillStyle;
  ctx.fillStyle = "#ffffff";
  ctx.fillStyle = value.trim();
  return ctx.fillStyle === first ? first : undefined;
}

// The free TradingView Advanced Chart widget for one TradingView symbol. The script is
// mounted into the container and replaced when the symbol changes (our picker owns the
// symbol, so the widget's own symbol search is off), or when the theme changes (the widget takes
// its theme and colors at creation); drawing tools and indicators stay,
// and TradingView's attribution link stays visible under the chart. It is an essential
// script (docs/decisions.md), so it loads without waiting for cookie consent.
// Below md an overlay keeps the iframe from trapping page scroll: tap it to use the chart.
// A chart-shaped skeleton shows until the widget's iframe fires load; the script is added after
// the first paint and the widget then fades in over 250 ms.
export function TradingViewChart({ symbol, className }: { symbol: string; className?: string }) {
  const t = useTranslations("Chart");
  const theme = useTheme();
  const host = useRef<HTMLDivElement>(null);
  const [locked, setLocked] = useState(true);
  // The symbol and theme whose iframe has loaded; the widget is shown only for the current pair.
  const [loaded, setLoaded] = useState<string | null>(null);
  const key = `${symbol}|${theme}`;
  const ready = loaded === key;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const css = getComputedStyle(document.documentElement);
    const background = toColor(css.getPropertyValue("--background"));
    const up = toColor(css.getPropertyValue("--up"));
    const down = toColor(css.getPropertyValue("--down"));
    const grid = toColor(css.getPropertyValue("--chart-grid"));

    const widget = document.createElement("div");
    widget.className = "tradingview-widget-container__widget h-[calc(100%-1.5rem)] w-full";
    const copyright = document.createElement("div");
    copyright.className = "tradingview-widget-copyright h-6 text-center text-[11px] leading-6";
    const link = document.createElement("a");
    link.href = "https://www.tradingview.com/";
    link.target = "_blank";
    link.rel = "noopener nofollow";
    link.textContent = "Track all markets on TradingView";
    link.className = "text-muted-foreground underline-offset-2 hover:underline";
    copyright.append(link);
    const script = document.createElement("script");
    script.src = SCRIPT;
    script.async = true;
    script.type = "text/javascript";
    script.textContent = JSON.stringify({
      autosize: true,
      symbol,
      interval: "15",
      timezone: "Etc/UTC",
      theme,
      style: "1",
      locale: "en",
      ...(background ? { backgroundColor: background } : {}),
      ...(grid ? { gridColor: grid } : {}),
      allow_symbol_change: false,
      hide_top_toolbar: false,
      hide_side_toolbar: false,
      hide_legend: false,
      save_image: false,
      calendar: false,
      support_host: "https://www.tradingview.com",
      overrides: {
        ...(up
          ? {
              "mainSeriesProperties.candleStyle.upColor": up,
              "mainSeriesProperties.candleStyle.borderUpColor": up,
              "mainSeriesProperties.candleStyle.wickUpColor": up,
            }
          : {}),
        ...(down
          ? {
              "mainSeriesProperties.candleStyle.downColor": down,
              "mainSeriesProperties.candleStyle.borderDownColor": down,
              "mainSeriesProperties.candleStyle.wickDownColor": down,
            }
          : {}),
      },
    });
    // The widget script inserts the iframe; wait for it, then for its load event.
    const observer = new MutationObserver(() => {
      const iframe = el.querySelector("iframe");
      if (!iframe) return;
      observer.disconnect();
      iframe.addEventListener("load", () => setLoaded(key), { once: true });
    });
    observer.observe(el, { childList: true, subtree: true });
    // After the first paint, so the skeleton shows before the script starts.
    const frame = requestAnimationFrame(() => el.replaceChildren(widget, copyright, script));
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      el.replaceChildren();
    };
  }, [symbol, theme, key]);

  // Re-lock when the finger or pointer goes anywhere else, so the page scrolls again.
  useEffect(() => {
    if (locked) return;
    const relock = (e: PointerEvent) => {
      if (!host.current?.contains(e.target as Node)) setLocked(true);
    };
    document.addEventListener("pointerdown", relock);
    return () => document.removeEventListener("pointerdown", relock);
  }, [locked]);

  return (
    <div className={cn("relative h-[420px] overflow-hidden rounded-xl border bg-background lg:h-[520px]", className)}>
      {ready ? null : (
        <div aria-hidden="true" className="absolute inset-0 flex flex-col gap-2 p-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="w-full flex-1" />
        </div>
      )}
      <div
        ref={host}
        aria-label={t("label")}
        className={cn(
          "tradingview-widget-container h-full w-full transition-opacity duration-250 ease-out-strong",
          ready ? "opacity-100" : "opacity-0",
        )}
      />
      {locked ? (
        <button
          type="button"
          onClick={() => setLocked(false)}
          className="absolute inset-0 z-10 flex items-end justify-center bg-transparent pb-8 text-xs text-muted-foreground md:hidden"
        >
          <span className="rounded-full bg-muted px-3 py-1.5">{t("unlock")}</span>
        </button>
      ) : null}
    </div>
  );
}
