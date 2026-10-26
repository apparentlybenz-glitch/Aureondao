import { ProviderError } from "./types";

export type CacheResult<T> = { value: T; stale: boolean };

type Options<T> = {
  load: () => Promise<T>;
  // A value younger than this is fresh and served without calling load.
  ttlMs: number;
  // After a failed load, load is not called again for this long.
  negativeTtlMs: number;
  // When load fails, the last good value is still served while it is no older than this.
  maxStaleMs: number;
  now?: () => number;
  onError?: (error: unknown, info: { servedStale: boolean }) => void;
};

// One value with a TTL, one shared load in flight, a negative window after a
// failure and a bounded stale fallback. Tickers keep their own ts inside the
// value, so a stale answer still shows its real age to the client.
export function createStaleCache<T>(options: Options<T>) {
  const { load, ttlMs, negativeTtlMs, maxStaleMs, onError } = options;
  const now = options.now ?? Date.now;
  let good: { value: T; at: number } | null = null;
  let retryAfter = 0;
  let lastError: unknown = null;
  let inFlight: Promise<void> | null = null;

  function answer(t: number): CacheResult<T> | null {
    if (!good) return null;
    const age = t - good.at;
    if (age < ttlMs) return { value: good.value, stale: false };
    return age <= maxStaleMs ? { value: good.value, stale: true } : null;
  }

  async function refresh() {
    try {
      const value = await load();
      good = { value, at: now() };
      retryAfter = 0;
      lastError = null;
    } catch (error) {
      lastError = error;
      retryAfter = now() + negativeTtlMs;
      onError?.(error, { servedStale: answer(now()) !== null });
    }
  }

  return async function get(): Promise<CacheResult<T>> {
    const fresh = answer(now());
    if (fresh && !fresh.stale) return fresh;
    if (now() >= retryAfter) {
      inFlight ??= refresh().finally(() => {
        inFlight = null;
      });
      await inFlight;
    }
    const result = answer(now());
    if (!result) throw lastError ?? new ProviderError("Upstream unavailable");
    return result;
  };
}
