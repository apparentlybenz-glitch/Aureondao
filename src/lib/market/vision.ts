import { isDecimal, isPositiveDecimal } from "./decimal";
import { ProviderError } from "./types";
import type { Market, Ticker } from "./types";

const VISION_URL = "https://data-api.binance.vision/api/v3/ticker/24hr";

// One request for every market. Twenty symbols or fewer cost weight 2 (21-100
// cost 40), so keep at most 20 enabled markets. The symbols value is JSON.
export function visionUrl(markets: Market[]): string {
  const symbols = JSON.stringify(markets.map((m) => m.visionSymbol));
  return `${VISION_URL}?symbols=${encodeURIComponent(symbols)}`;
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
