"use client";

import Link from "next/link";
import { useState } from "react";
import { Star } from "lucide-react";
import { useTranslations } from "next-intl";
import { CoinIcon } from "@/components/market/coin-icon";
import { ForexMarketList } from "@/components/market/forex-market-list";
import { formatChange, formatPrice } from "@/lib/market/decimal";
import { useFavorites } from "@/lib/market/favorites";
import { saveLastMarket } from "@/lib/market/last-symbol";
import { MARKET_TYPES } from "@/lib/market/market-types";
import type { MarketType } from "@/lib/market/market-types";
import { rankMarkets } from "@/lib/market/rank";
import type { TableTab } from "@/lib/market/rank";
import { isDelayed } from "@/lib/market/types";
import type { Market } from "@/lib/market/types";
import { useMarketData } from "@/lib/market/use-market-data";
import { cn } from "@/lib/utils";
import { LoadingRows } from "@/components/ui/skeleton";

const TABS: TableTab[] = ["optional", "popular", "gainer", "down"];
const HOME_ROWS = 8;
const GRID =
  "grid min-w-0 flex-1 grid-cols-[minmax(7.5rem,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_3.75rem] items-center gap-1";

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
// onSelect (the Spot market picker) is called after a row tap saves the symbol. The type
// selector (Spot or Forex) shows only where onTypeChange is given: the Market page. Home and the
// Spot picker are crypto only. Favorites stay crypto only.
export function MarketTable({
  variant,
  query = "",
  onQueryChange,
  onSelect,
  type = "spot",
  onTypeChange,
}: {
  variant: "home" | "market";
  query?: string;
  onQueryChange?: (value: string) => void;
  onSelect?: (id: string) => void;
  type?: MarketType;
  onTypeChange?: (type: MarketType) => void;
}) {
  const t = useTranslations("Market");
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
  const loading = markets ? tab === "optional" && !favorites : !failing;
  let message: string | null = null;
  if (!markets) message = failing ? t("unavailable") : null;
  else if (loading) message = null;
  else if (rows.length === 0) message = tab === "optional" && !query.trim() ? t("emptyOptional") : t("noResults");

  const typeSelect = (
    <select
      aria-label={t("types.label")}
      value={type}
      onChange={(e) => onTypeChange?.(MARKET_TYPES.find((x) => x === e.target.value) ?? "spot")}
      className="h-8 w-[4.5rem] shrink-0 rounded-md bg-muted px-2 text-xs pointer-coarse:text-base text-foreground"
    >
      {MARKET_TYPES.map((key) => (
        <option key={key} value={key}>
          {t(`types.${key}`)}
        </option>
      ))}
    </select>
  );
  const search = isMarket ? (
    <input
      type="search"
      value={query}
      onChange={(e) => onQueryChange?.(e.target.value)}
      placeholder={t("searchPlaceholder")}
      aria-label={t("searchLabel")}
      className="h-10 w-full rounded-full bg-muted px-4 text-base text-foreground outline-none placeholder:text-muted-foreground"
    />
  ) : null;

  if (onTypeChange && type === "forex") {
    return (
      <section className="space-y-3" aria-label={t("title")}>
        {search}
        <div className="flex justify-end">{typeSelect}</div>
        <ForexMarketList query={query} />
      </section>
    );
  }

  return (
    <section className="space-y-3" aria-label={t("title")}>
      {search}

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
                "press shrink-0 border-b-2 py-1.5",
                tab === key
                  ? "border-primary font-semibold text-foreground"
                  : "border-transparent text-muted-foreground",
              )}
            >
              {t(`tabs.${key}`)}
            </button>
          ))}
        </div>
        {onTypeChange ? typeSelect : null}
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

      {loading ? (
        <LoadingRows label={t("loading")} rows={HOME_ROWS} className="space-y-3 py-2.5" rowClassName="h-9" />
      ) : message ? (
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
                    <CoinIcon symbol={m.base} size={24} />
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
    </section>
  );
}
