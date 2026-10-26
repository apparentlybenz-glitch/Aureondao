const KEY = "aureonx.lastMarket";
export const DEFAULT_MARKET = "BTC-USDT";

// The Trade tab opens Spot on this symbol (docs/decisions.md O24). Storage can
// throw (private windows, blocked site data), so every access is guarded.
export function readLastMarket(): string {
  try {
    return localStorage.getItem(KEY) ?? DEFAULT_MARKET;
  } catch {
    return DEFAULT_MARKET;
  }
}

export function saveLastMarket(id: string): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // Not saved; the default symbol applies next time.
  }
}
