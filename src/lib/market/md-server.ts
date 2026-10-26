import "server-only";
import { createClient } from "@supabase/supabase-js";
import { supabasePublishableKey, supabaseUrl } from "@/lib/supabase/env";
import { getJson } from "./http";
import { KUCOIN_URL, normalizeKucoin } from "./kucoin";
import { MARKET_COLUMNS, ProviderError, toMarket } from "./types";
import type { Market, MarketRow, Ticker } from "./types";

// Caches live in this isolate's memory. The Cache API does nothing on a
// workers.dev address, so each isolate keeps its own copy (docs/market-data.md §5).
export const TICKERS_TTL_MS = 5_000;
export const TICKERS_NEGATIVE_TTL_MS = 10_000;
export const MARKETS_TTL_MS = 60_000;
const ATTEMPT_TIMEOUT_MS = 1_200;
const RETRIES = 2;
const BACKOFF_MS = 150;

type Cached<T> = { expires: number; value: T | null; failed: boolean };

// One shared fetch per TTL window: the cache entry, plus the call in flight.
function createCache<T>(load: () => Promise<T>, ttlMs: number, negativeTtlMs: number, keepStale: boolean) {
  let entry: Cached<T> | null = null;
  let inFlight: Promise<Cached<T>> | null = null;
  return async function get(): Promise<T> {
    const now = Date.now();
    if (!entry || now >= entry.expires) {
      inFlight ??= load()
        .then((value): Cached<T> => ({ expires: Date.now() + ttlMs, value, failed: false }))
        .catch((): Cached<T> => ({
          expires: Date.now() + negativeTtlMs,
          value: keepStale ? (entry?.value ?? null) : null,
          failed: true,
        }))
        .then((next) => {
          entry = next;
          inFlight = null;
          return next;
        });
      await inFlight;
    }
    if (!entry || entry.value === null) throw new ProviderError("Upstream unavailable");
    return entry.value;
  };
}

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
  throw lastError;
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
  if (error) throw new ProviderError(error.message);
  return data.map(toMarket);
}

export const getEnabledMarkets = createCache(readEnabledMarkets, MARKETS_TTL_MS, MARKETS_TTL_MS, true);

async function readKucoinTickers(): Promise<Ticker[]> {
  const markets = await getEnabledMarkets();
  const payload = await withRetries(() =>
    getJson((url, init) => fetch(url, { ...init, cache: "no-store" }), KUCOIN_URL, ATTEMPT_TIMEOUT_MS),
  );
  const tickers = normalizeKucoin(payload, markets);
  if (tickers.length === 0) throw new ProviderError("No usable tickers");
  return tickers;
}

export const getKucoinTickers = createCache(readKucoinTickers, TICKERS_TTL_MS, TICKERS_NEGATIVE_TTL_MS, false);
