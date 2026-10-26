// One normalized ticker per market. Prices and volume stay decimal strings;
// changePct is a decimal percent string ("-0.31" means -0.31 %), parsed only for
// sorting and display. ts is the provider's own timestamp in epoch ms.
export type Ticker = {
  id: string;
  last: string;
  bid: string;
  ask: string;
  changePct: string;
  quoteVolume: string;
  ts: number;
};

export type Market = {
  id: string;
  base: string;
  quote: string;
  displaySymbol: string;
  visionSymbol: string;
  kucoinSymbol: string;
  priceDecimals: number;
  sortOrder: number;
};

export type MarketRow = {
  id: string;
  base: string;
  quote: string;
  display_symbol: string;
  vision_symbol: string;
  kucoin_symbol: string;
  price_decimals: number;
  sort_order: number;
};

export const MARKET_COLUMNS =
  "id, base, quote, display_symbol, vision_symbol, kucoin_symbol, price_decimals, sort_order";

export function toMarket(row: MarketRow): Market {
  return {
    id: row.id,
    base: row.base,
    quote: row.quote,
    displaySymbol: row.display_symbol,
    visionSymbol: row.vision_symbol,
    kucoinSymbol: row.kucoin_symbol,
    priceDecimals: row.price_decimals,
    sortOrder: row.sort_order,
  };
}

// A ticker older than this is shown as delayed.
export const DELAYED_AFTER_MS = 60_000;

export function isDelayed(ts: number, now: number): boolean {
  return now - ts > DELAYED_AFTER_MS;
}

// Non-2xx or unusable provider answer. status is null for network errors and timeouts.
export class ProviderError extends Error {
  status: number | null;
  // Retries used before giving up (set by the server's retry loop).
  retries = 0;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}
