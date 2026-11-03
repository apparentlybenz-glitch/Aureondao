// The Market page's type selector: Spot and Forex only. A stale or unknown value (for example
// ?type=options from an old link) falls back to Spot.
export const MARKET_TYPES = ["spot", "forex"] as const;
export type MarketType = (typeof MARKET_TYPES)[number];

export function parseMarketType(value: string | null | undefined): MarketType {
  return MARKET_TYPES.find((t) => t === value) ?? "spot";
}
