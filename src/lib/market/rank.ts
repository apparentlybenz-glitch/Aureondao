import { toSortNumber } from "./decimal";
import type { Market, Ticker } from "./types";

export type TableTab = "optional" | "popular" | "gainer" | "down";

// Rows without a ticker yet go last. Float ordering is for sorting only.
export function rankMarkets(
  markets: Market[],
  tickers: Readonly<Record<string, Ticker>>,
  tab: Exclude<TableTab, "optional">,
): Market[] {
  const value = (m: Market): number | null => {
    const t = tickers[m.id];
    if (!t) return null;
    return tab === "popular" ? toSortNumber(t.quoteVolume) : toSortNumber(t.changePct);
  };
  const direction = tab === "down" ? 1 : -1; // popular and gainer: high first
  return [...markets].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === null && vb === null) return a.sortOrder - b.sortOrder;
    if (va === null) return 1;
    if (vb === null) return -1;
    return va === vb ? a.sortOrder - b.sortOrder : (va - vb) * direction;
  });
}
