import { isDecimal, isPositiveDecimal } from "./decimal";
import { getJson } from "./http";
import type { FetchLike } from "./http";
import { ProviderError } from "./types";
import type { Market } from "./types";

// Chart candles. Display only: no money path reads them.
export const INTERVALS = ["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"] as const;
export type Interval = (typeof INTERVALS)[number];

const MINUTE = 60_000;
export const INTERVAL_MS: Record<Interval, number> = {
  "1m": MINUTE,
  "5m": 5 * MINUTE,
  "15m": 15 * MINUTE,
  "30m": 30 * MINUTE,
  "1h": 60 * MINUTE,
  "4h": 240 * MINUTE,
  "1d": 1440 * MINUTE,
  "1w": 10080 * MINUTE,
};

// Vision uses the same interval names; KuCoin has its own.
const KUCOIN_TYPE: Record<Interval, string> = {
  "1m": "1min",
  "5m": "5min",
  "15m": "15min",
  "30m": "30min",
  "1h": "1hour",
  "4h": "4hour",
  "1d": "1day",
  "1w": "1week",
};

export const KLINE_LIMIT = 300;
export const KLINES_VISION_TIMEOUT_MS = 4_000;
export const KLINES_MD_TIMEOUT_MS = 5_000;
export const MD_KLINES_PATH = "/md/v1/klines";

// time is the candle's open time in epoch seconds; prices stay decimal strings.
export type Candle = { time: number; open: string; high: string; low: string; close: string };

export function isInterval(value: unknown): value is Interval {
  return typeof value === "string" && (INTERVALS as readonly string[]).includes(value);
}

function candle(time: unknown, open: unknown, high: unknown, low: unknown, close: unknown): Candle | null {
  if (typeof time !== "number" || !Number.isFinite(time)) return null;
  if (![open, high, low, close].every(isPositiveDecimal)) return null;
  return { time, open: open as string, high: high as string, low: low as string, close: close as string };
}

export function visionKlinesUrl(market: Market, interval: Interval): string {
  return `https://data-api.binance.vision/api/v3/klines?symbol=${market.visionSymbol}&interval=${interval}&limit=${KLINE_LIMIT}`;
}

// Vision rows: [openTime ms, open, high, low, close, volume, ...], oldest first.
export function normalizeVisionKlines(payload: unknown): Candle[] {
  if (!Array.isArray(payload)) throw new ProviderError("Unexpected klines payload");
  const out: Candle[] = [];
  for (const row of payload) {
    if (!Array.isArray(row)) continue;
    const c = candle(typeof row[0] === "number" ? Math.floor(row[0] / 1000) : null, row[1], row[2], row[3], row[4]);
    if (c) out.push(c);
  }
  return out;
}

export function kucoinKlinesUrl(market: Market, interval: Interval, nowMs: number): string {
  const end = Math.floor(nowMs / 1000);
  const start = end - Math.floor((INTERVAL_MS[interval] * KLINE_LIMIT) / 1000);
  return `https://api.kucoin.com/api/v1/market/candles?type=${KUCOIN_TYPE[interval]}&symbol=${market.kucoinSymbol}&startAt=${start}&endAt=${end}`;
}

// KuCoin rows: [time s (string), open, close, high, low, volume, turnover], newest first.
export function normalizeKucoinKlines(payload: unknown): Candle[] {
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new ProviderError("Unexpected klines payload");
  const out: Candle[] = [];
  for (const row of data) {
    if (!Array.isArray(row) || !isDecimal(row[0])) continue;
    const c = candle(Number(row[0]), row[1], row[3], row[4], row[2]);
    if (c) out.push(c);
  }
  return out.sort((a, b) => a.time - b.time);
}

// The /md/v1/klines response is already normalized; the browser re-checks it.
export function parseMdKlines(payload: unknown): Candle[] {
  const list = (payload as { candles?: unknown } | null)?.candles;
  if (!Array.isArray(list)) throw new ProviderError("Unexpected klines payload");
  const out: Candle[] = [];
  for (const c of list as Partial<Record<keyof Candle, unknown>>[]) {
    const parsed = c && typeof c === "object" ? candle(c.time, c.open, c.high, c.low, c.close) : null;
    if (parsed) out.push(parsed);
  }
  return out;
}

// Vision first; on any failure the shared Worker route (KuCoin) answers instead.
export async function loadKlines(
  fetchImpl: FetchLike,
  market: Market,
  interval: Interval,
): Promise<{ candles: Candle[]; source: "vision" | "md" }> {
  try {
    const candles = normalizeVisionKlines(await getJson(fetchImpl, visionKlinesUrl(market, interval), KLINES_VISION_TIMEOUT_MS));
    if (candles.length > 0) return { candles, source: "vision" };
  } catch {
    // fall through to the Worker route
  }
  const url = `${MD_KLINES_PATH}?symbol=${encodeURIComponent(market.id)}&interval=${interval}`;
  const candles = parseMdKlines(await getJson(fetchImpl, url, KLINES_MD_TIMEOUT_MS));
  if (candles.length === 0) throw new ProviderError("No usable candles");
  return { candles, source: "md" };
}

// Next refresh: shortly after the current candle closes, at least once a minute.
export function klinesRefreshDelay(interval: Interval, nowMs: number, random: number): number {
  const step = Math.min(INTERVAL_MS[interval], MINUTE);
  return step - (nowMs % step) + 1_000 + Math.floor(random * 1_000);
}
