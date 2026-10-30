"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

const SCRIPT = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";

// A CSS color (the theme tokens are hex today) as #rrggbb, which the widget needs.
function toHex(value: string, fallback: string): string {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx || !value.trim()) return fallback;
  ctx.fillStyle = "#000000";
  ctx.fillStyle = value.trim();
  return ctx.fillStyle.startsWith("#") ? ctx.fillStyle : fallback;
}

// The free TradingView Advanced Chart widget for one TradingView symbol. The script is
// mounted into the container and replaced when the symbol changes (our picker owns the
// symbol, so the widget's own symbol search is off); drawing tools and indicators stay,
// and TradingView's attribution link stays visible under the chart. It is an essential
// script (docs/decisions.md), so it loads without waiting for cookie consent.
// Below md an overlay keeps the iframe from trapping page scroll: tap it to use the chart.
export function TradingViewChart({ symbol, className }: { symbol: string; className?: string }) {
  const t = useTranslations("Chart");
  const host = useRef<HTMLDivElement>(null);
  const [locked, setLocked] = useState(true);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const css = getComputedStyle(document.documentElement);
    const background = toHex(css.getPropertyValue("--background"), "#151a18");
    const up = toHex(css.getPropertyValue("--up"), "#0fa644");
    const down = toHex(css.getPropertyValue("--down"), "#ee266a");

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
      theme: "dark",
      style: "1",
      locale: "en",
      backgroundColor: background,
      gridColor: "rgba(255, 255, 255, 0.06)",
      allow_symbol_change: false,
      hide_top_toolbar: false,
      hide_side_toolbar: false,
      hide_legend: false,
      save_image: false,
      calendar: false,
      support_host: "https://www.tradingview.com",
      overrides: {
        "mainSeriesProperties.candleStyle.upColor": up,
        "mainSeriesProperties.candleStyle.borderUpColor": up,
        "mainSeriesProperties.candleStyle.wickUpColor": up,
        "mainSeriesProperties.candleStyle.downColor": down,
        "mainSeriesProperties.candleStyle.borderDownColor": down,
        "mainSeriesProperties.candleStyle.wickDownColor": down,
      },
    });
    el.replaceChildren(widget, copyright, script);
    return () => el.replaceChildren();
  }, [symbol]);

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
      <div ref={host} aria-label={t("label")} className="tradingview-widget-container h-full w-full" />
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
