import { fractionToPercent, isDecimal, isPositiveDecimal } from "./decimal";
import { ProviderError } from "./types";
import type { Market, Ticker } from "./types";

export const KUCOIN_URL = "https://api.kucoin.com/api/v1/market/allTickers";

type KucoinRow = {
  symbol?: unknown;
  buy?: unknown; // best bid
  sell?: unknown; // best ask
  last?: unknown;
  changeRate?: unknown; // a fraction: "-0.003" is -0.3 %
  volValue?: unknown; // 24h quote volume
};

// KuCoin names are the reverse of what they look like: buy is the best bid and
// sell is the best ask. data.time is one timestamp for the whole response.
// Rows with a null or zero side are dropped, never filled in.
export function normalizeKucoin(payload: unknown, markets: Market[]): Ticker[] {
  const data = (payload as { data?: { time?: unknown; ticker?: unknown } } | null)?.data;
  if (!data || typeof data.time !== "number" || !Array.isArray(data.ticker)) {
    throw new ProviderError("Unexpected ticker payload");
  }
  const bySymbol = new Map(markets.map((m) => [m.kucoinSymbol, m]));
  const out: Ticker[] = [];
  for (const row of data.ticker as KucoinRow[]) {
    if (typeof row !== "object" || row === null || typeof row.symbol !== "string") continue;
    const market = bySymbol.get(row.symbol);
    if (!market) continue;
    const { buy, sell, last, changeRate, volValue } = row;
    if (
      !isPositiveDecimal(last) ||
      !isPositiveDecimal(buy) ||
      !isPositiveDecimal(sell) ||
      !isDecimal(changeRate) ||
      !isDecimal(volValue)
    ) {
      continue;
    }
    const changePct = fractionToPercent(changeRate);
    if (changePct === null) continue;
    out.push({
      id: market.id,
      last,
      bid: buy,
      ask: sell,
      changePct,
      quoteVolume: volValue,
      ts: data.time,
    });
  }
  return out;
}

// The /md/v1/tickers response is already normalized; the browser re-checks it.
export function parseMdResponse(payload: unknown): Ticker[] {
  const list = (payload as { tickers?: unknown } | null)?.tickers;
  if (!Array.isArray(list)) throw new ProviderError("Unexpected ticker payload");
  const out: Ticker[] = [];
  for (const t of list as Partial<Record<keyof Ticker, unknown>>[]) {
    if (
      typeof t === "object" &&
      t !== null &&
      typeof t.id === "string" &&
      isPositiveDecimal(t.last) &&
      isPositiveDecimal(t.bid) &&
      isPositiveDecimal(t.ask) &&
      isDecimal(t.changePct) &&
      isDecimal(t.quoteVolume) &&
      typeof t.ts === "number" &&
      Number.isFinite(t.ts)
    ) {
      out.push({
        id: t.id,
        last: t.last,
        bid: t.bid,
        ask: t.ask,
        changePct: t.changePct,
        quoteVolume: t.quoteVolume,
        ts: t.ts,
      });
    }
  }
  return out;
}
