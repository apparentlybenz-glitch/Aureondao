import { isDecimal, isPositiveDecimal } from "./decimal";
import { ProviderError } from "./types";
import type { Market, Ticker } from "./types";

const VISION_URL = "https://data-api.binance.vision/api/v3/ticker/24hr";

// Vision ticker/24hr costs weight 2 for 1 to 20 symbols and 40 above that, so
// every call carries at most VISION_BATCH symbols and any number of enabled
// markets is split across calls. The symbols value is JSON.
export const VISION_BATCH = 20;

export function visionUrl(markets: Market[]): string {
  const symbols = JSON.stringify(markets.map((m) => m.visionSymbol));
  return `${VISION_URL}?symbols=${encodeURIComponent(symbols)}`;
}

// One URL per batch of at most VISION_BATCH markets, in market order.
export function visionUrls(markets: Market[]): string[] {
  const urls: string[] = [];
  for (let i = 0; i < markets.length; i += VISION_BATCH) urls.push(visionUrl(markets.slice(i, i + VISION_BATCH)));
  return urls;
}

type VisionRow = {
  symbol?: unknown;
  lastPrice?: unknown;
  bidPrice?: unknown;
  askPrice?: unknown;
  priceChangePercent?: unknown;
  quoteVolume?: unknown;
  highPrice?: unknown;
  lowPrice?: unknown;
  closeTime?: unknown;
};

// Rows without a usable last, bid, ask or closeTime are dropped, never filled in.
// ts is closeTime, so a stale book (a delisted pair) shows as delayed.
export function normalizeVision(payload: unknown, markets: Market[]): Ticker[] {
  if (!Array.isArray(payload)) throw new ProviderError("Unexpected ticker payload");
  const bySymbol = new Map(markets.map((m) => [m.visionSymbol, m]));
  const out: Ticker[] = [];
  for (const row of payload as VisionRow[]) {
    if (typeof row !== "object" || row === null || typeof row.symbol !== "string") continue;
    const market = bySymbol.get(row.symbol);
    if (!market) continue;
    const { lastPrice, bidPrice, askPrice, priceChangePercent, quoteVolume, closeTime, highPrice, lowPrice } = row;
    if (
      !isPositiveDecimal(lastPrice) ||
      !isPositiveDecimal(bidPrice) ||
      !isPositiveDecimal(askPrice) ||
      !isDecimal(priceChangePercent) ||
      !isDecimal(quoteVolume) ||
      !isDecimal(highPrice) ||
      !isDecimal(lowPrice) ||
      typeof closeTime !== "number" ||
      !Number.isFinite(closeTime)
    ) {
      continue;
    }
    out.push({
      id: market.id,
      last: lastPrice,
      bid: bidPrice,
      ask: askPrice,
      changePct: priceChangePercent,
      quoteVolume,
      high: highPrice,
      low: lowPrice,
      ts: closeTime,
    });
  }
  return out;
}
