import "server-only";
import { captureException } from "@sentry/nextjs/cloudflare";
import { createClient } from "@supabase/supabase-js";
import { supabasePublishableKey, supabaseUrl } from "@/lib/supabase/env";
import { getJson } from "./http";
import { KUCOIN_URL, normalizeKucoin } from "./kucoin";
import { kucoinKlinesUrl, normalizeKucoinKlines } from "./klines";
import type { Candle, Interval } from "./klines";
import { createStaleCache } from "./stale-cache";
import { MARKET_COLUMNS, ProviderError, toMarket } from "./types";
import type { Market, MarketRow, Ticker } from "./types";

// Caches live in this isolate's memory. The Cache API does nothing on a
// workers.dev address, so each isolate keeps its own copy (docs/market-data.md §5).
export const TICKERS_TTL_MS = 5_000;
export const TICKERS_NEGATIVE_TTL_MS = 10_000;
// When KuCoin fails, the last good response is still served for this long.
export const TICKERS_MAX_STALE_MS = 60_000;
export const MARKETS_TTL_MS = 60_000;
const ATTEMPT_TIMEOUT_MS = 1_200;
const RETRIES = 2;
const BACKOFF_MS = 150;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// At most RETRIES retries, with jittered backoff between attempts.
async function withRetries<T>(attempt: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i <= RETRIES; i++) {
    try {
      return await attempt();
    } catch (e) {
      lastError = e;
      if (i < RETRIES) await sleep(BACKOFF_MS * (i + 1) * (0.5 + Math.random()));
    }
  }
  if (lastError instanceof ProviderError) lastError.retries = RETRIES;
  throw lastError;
}

// Names the failing upstream in the message and keeps its status and retry count.
function labelled(upstream: string, error: unknown): ProviderError {
  const source = error instanceof ProviderError ? error : new ProviderError(String(error));
  const out = new ProviderError(`${upstream}: ${source.message}`, source.status);
  out.retries = source.retries;
  return out;
}

// Every failed refresh goes to Workers Logs and Sentry with the upstream status
// and the retry count. The negative window keeps this to one per 10 s per isolate.
function reportUpstreamFailure(route: string, error: unknown, info: { servedStale: boolean }) {
  const failure = error instanceof ProviderError ? error : new ProviderError(String(error));
  const context = {
    route,
    upstreamStatus: failure.status,
    retries: failure.retries,
    servedStale: info.servedStale,
    message: failure.message,
  };
  console.error(JSON.stringify({ event: route === "/md/v1/tickers" ? "md_tickers_refresh_failed" : "md_klines_refresh_failed", ...context }));
  captureException(failure, {
    tags: { route: context.route, upstream_status: String(context.upstreamStatus) },
    extra: context,
  });
}

async function readEnabledMarkets(): Promise<Market[]> {
  // Publishable key under RLS, no cookies: the same rows an anonymous visitor sees.
  const supabase = createClient(supabaseUrl, supabasePublishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase
    .from("markets")
    .select(MARKET_COLUMNS)
    .eq("enabled", true)
    .order("sort_order")
    .overrideTypes<MarketRow[], { merge: false }>();
  if (error) throw new ProviderError(`Supabase: ${error.message}`);
  return data.map(toMarket);
}

// The last list is kept for as long as it takes: a failed refresh never empties it.
const markets = createStaleCache({
  load: readEnabledMarkets,
  ttlMs: MARKETS_TTL_MS,
  negativeTtlMs: TICKERS_NEGATIVE_TTL_MS,
  maxStaleMs: Number.POSITIVE_INFINITY,
});

async function readKucoinTickers(): Promise<Ticker[]> {
  const { value: list } = await markets();
  let payload: unknown;
  try {
    payload = await withRetries(() =>
      getJson((url, init) => fetch(url, { ...init, cache: "no-store" }), KUCOIN_URL, ATTEMPT_TIMEOUT_MS),
    );
  } catch (e) {
    throw labelled("KuCoin", e);
  }
  try {
    const tickers = normalizeKucoin(payload, list);
    if (tickers.length === 0) throw new ProviderError("No usable tickers");
    return tickers;
  } catch (e) {
    throw labelled("KuCoin", e);
  }
}

export const getKucoinTickers = createStaleCache({
  load: readKucoinTickers,
  ttlMs: TICKERS_TTL_MS,
  negativeTtlMs: TICKERS_NEGATIVE_TTL_MS,
  maxStaleMs: TICKERS_MAX_STALE_MS,
  onError: (error, info) => reportUpstreamFailure("/md/v1/tickers", error, info),
});

// Enabled market by id, from the same cached list; null when unknown or disabled.
export async function findEnabledMarket(id: string): Promise<Market | null> {
  const { value: list } = await markets();
  return list.find((m) => m.id === id) ?? null;
}

async function readKucoinKlines(market: Market, interval: Interval): Promise<Candle[]> {
  let payload: unknown;
  try {
    payload = await withRetries(() =>
      getJson(
        (url, init) => fetch(url, { ...init, cache: "no-store" }),
        kucoinKlinesUrl(market, interval, Date.now()),
        ATTEMPT_TIMEOUT_MS,
      ),
    );
  } catch (e) {
    throw labelled("KuCoin", e);
  }
  try {
    const candles = normalizeKucoinKlines(payload);
    if (candles.length === 0) throw new ProviderError("No usable candles");
    return candles;
  } catch (e) {
    throw labelled("KuCoin", e);
  }
}

// One cache per (market, interval), with the ticker route's rules. The keys are
// bounded: only enabled markets and the 8 intervals reach this.
const klineCaches = new Map<string, () => Promise<{ value: Candle[]; stale: boolean }>>();

export function getKucoinKlines(market: Market, interval: Interval) {
  const key = `${market.id}|${interval}`;
  let get = klineCaches.get(key);
  if (!get) {
    get = createStaleCache({
      load: () => readKucoinKlines(market, interval),
      ttlMs: TICKERS_TTL_MS,
      negativeTtlMs: TICKERS_NEGATIVE_TTL_MS,
      maxStaleMs: TICKERS_MAX_STALE_MS,
      onError: (error, info) => reportUpstreamFailure("/md/v1/klines", error, info),
    });
    klineCaches.set(key, get);
  }
  return get();
}
