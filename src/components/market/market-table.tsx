"use client";

import Link from "next/link";
import { useState } from "react";
import { Star } from "lucide-react";
import { useTranslations } from "next-intl";
import { CoinBadge } from "@/components/market/coin-badge";
import { formatChange, formatPrice } from "@/lib/market/decimal";
import { useFavorites } from "@/lib/market/favorites";
import { saveLastMarket } from "@/lib/market/last-symbol";
import { rankMarkets } from "@/lib/market/rank";
import type { TableTab } from "@/lib/market/rank";
import { isDelayed } from "@/lib/market/types";
import type { Market } from "@/lib/market/types";
import { useMarketData } from "@/lib/market/use-market-data";
import { cn } from "@/lib/utils";

const TABS: TableTab[] = ["optional", "popular", "gainer", "down"];
const TYPES = ["spot", "options", "forex", "perpetual"] as const;
const HOME_ROWS = 8;
const GRID =
  "grid min-w-0 flex-1 grid-cols-[minmax(5.75rem,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_4.25rem] items-center gap-1.5";

const timeFormat = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function matches(m: Market, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [m.displaySymbol, m.base, m.id, `${m.base}/${m.quote}`].some((s) => s.toLowerCase().includes(q));
}

// Home shows the first rows and a link; the Market tab shows every row with a
// search field and a star toggle. Both read the one store in use-market-data.
// onSelect (the Spot market picker) is called after a row tap saves the symbol.
export function MarketTable({
  variant,
  query = "",
  onQueryChange,
  onSelect,
}: {
  variant: "home" | "market";
  query?: string;
  onQueryChange?: (value: string) => void;
  onSelect?: (id: string) => void;
}) {
  const t = useTranslations("Market");
  const c = useTranslations("Common");
  const { markets, tickers, failing, now } = useMarketData();
  const { favorites, toggle } = useFavorites();
  const [tab, setTab] = useState<TableTab>("popular");
  const isMarket = variant === "market";

  let rows: Market[] = [];
  if (markets) {
    if (tab === "optional") {
      rows = favorites ? markets.filter((m) => favorites.has(m.id)) : [];
    } else {
      rows = rankMarkets(markets, tickers, tab);
    }
    if (isMarket) rows = rows.filter((m) => matches(m, query));
    else rows = rows.slice(0, HOME_ROWS);
  }

  const hasTickers = Object.keys(tickers).length > 0;
  let message: string | null = null;
  if (!markets) message = failing ? t("unavailable") : t("loading");
  else if (tab === "optional" && !favorites) message = t("loading");
  else if (rows.length === 0) message = tab === "optional" && !query.trim() ? t("emptyOptional") : t("noResults");

  return (
    <section className="space-y-3" aria-label={t("title")}>
      {isMarket ? (
        <input
          type="search"
          value={query}
          onChange={(e) => onQueryChange?.(e.target.value)}
          placeholder={t("searchPlaceholder")}
          aria-label={t("searchLabel")}
          className="h-10 w-full rounded-full bg-muted px-4 text-base text-foreground outline-none placeholder:text-muted-foreground"
        />
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <div role="tablist" className="flex min-w-0 gap-3.5 overflow-x-auto text-sm">
          {TABS.map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={cn(
                "shrink-0 border-b-2 py-1.5",
                tab === key
                  ? "border-primary font-semibold text-foreground"
                  : "border-transparent text-muted-foreground",
              )}
            >
              {t(`tabs.${key}`)}
            </button>
          ))}
        </div>
        <select
          aria-label={t("types.label")}
          defaultValue="spot"
          className="h-8 w-[4.5rem] shrink-0 rounded-md bg-muted px-2 text-xs text-foreground"
        >
          {TYPES.map((key) => (
            <option key={key} value={key} disabled={key !== "spot"}>
              {key === "spot" ? t("types.spot") : `${t(`types.${key}`)} · ${c("soon")}`}
            </option>
          ))}
        </select>
      </div>

      {failing && !hasTickers && markets ? (
        <p className="text-xs text-muted-foreground">{t("unavailable")}</p>
      ) : null}

      <div className={cn("flex items-center text-xs text-muted-foreground", isMarket && "pl-8")}>
        <div className={GRID}>
          <span>{t("columns.symbol")}</span>
          <span className="text-right">{t("columns.sell")}</span>
          <span className="text-right">{t("columns.buy")}</span>
          <span className="text-right">{t("columns.change")}</span>
        </div>
      </div>

      {message ? (
        <div className="space-y-3 py-8 text-center text-sm text-muted-foreground">
          <p>{message}</p>
          {tab === "optional" && !isMarket && favorites && rows.length === 0 ? (
            <Link href="/market" className="inline-block font-medium text-primary">
              {t("openMarket")}
            </Link>
          ) : null}
        </div>
      ) : (
        <ul>
          {rows.map((m) => {
            const ticker = tickers[m.id];
            const change = ticker ? formatChange(ticker.changePct) : null;
            const tone = change?.startsWith("+")
              ? "bg-up/15 text-up"
              : change?.startsWith("-")
                ? "bg-down/15 text-down"
                : "bg-muted text-muted-foreground";
            const starred = favorites?.has(m.id) ?? false;
            const symbol = `${m.base}/${m.quote}`;
            return (
              <li key={m.id} className="flex items-center">
                {isMarket ? (
                  <button
                    type="button"
                    onClick={() => void toggle(m.id)}
                    aria-pressed={starred}
                    aria-label={t(starred ? "removeFavorite" : "addFavorite", { symbol })}
                    className="flex size-8 shrink-0 items-center justify-center"
                  >
                    <Star className={cn("size-4", starred ? "fill-primary text-primary" : "text-muted-foreground")} />
                  </button>
                ) : null}
                <button type="button" onClick={() => {
                    saveLastMarket(m.id);
                    onSelect?.(m.id);
                  }} className={cn(GRID, "py-2.5 text-left")}>
                  <span className="flex min-w-0 items-center gap-1.5">
                    <CoinBadge symbol={m.base} />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{m.displaySymbol}</span>
                      {ticker ? (
                        isDelayed(ticker.ts, now) ? (
                          <span className="block text-[11px] text-muted-foreground">{t("delayed")}</span>
                        ) : (
                          <span className="block text-[11px] tabular-nums text-muted-foreground">
                            {timeFormat.format(ticker.ts)}
                          </span>
                        )
                      ) : null}
                    </span>
                  </span>
                  <span className="truncate text-right text-[13px] tabular-nums">
                    {ticker ? formatPrice(ticker.bid, m.priceDecimals) : "--"}
                  </span>
                  <span className="truncate text-right text-[13px] tabular-nums">
                    {ticker ? formatPrice(ticker.ask, m.priceDecimals) : "--"}
                  </span>
                  <span className={cn("rounded-md px-1.5 py-1 text-right text-xs font-medium tabular-nums", tone)}>
                    {change ?? "--"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {!isMarket && markets && rows.length > 0 ? (
        <Link href="/market" className="block py-1 text-center text-sm font-medium text-primary">
          {t("seeAll")}
        </Link>
      ) : null}
      <p className="text-center text-[11px] text-muted-foreground">{t("footnote")}</p>
    </section>
  );
}
