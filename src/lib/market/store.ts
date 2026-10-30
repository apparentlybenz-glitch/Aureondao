import { parseMdResponse } from "./kucoin";
import { getJson } from "./http";
import type { FetchLike } from "./http";
import { ProviderError } from "./types";
import type { Market, Ticker } from "./types";
import { normalizeVision, visionUrls } from "./vision";

export const POLL_MS = 5_000;
// Delay after n consecutive failed cycles (index n - 1); a success goes back to POLL_MS.
export const FAILURE_BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 60_000] as const;
export const VISION_TIMEOUT_MS = 4_000;
export const MD_TIMEOUT_MS = 5_000;
export const VISION_SKIP_MS = 30_000;
export const VISION_SKIP_JITTER_MS = 5_000;
export const MD_PATH = "/md/v1/tickers";

export type Snapshot = {
  markets: Market[] | null;
  tickers: Readonly<Record<string, Ticker>>;
  // Which provider answered the latest successful poll.
  source: "vision" | "md" | null;
  // True after a poll where every provider failed.
  failing: boolean;
  // Time of the latest poll; lets the UI mark old tickers as delayed.
  now: number;
};

export type StoreDeps = {
  loadMarkets: () => Promise<Market[]>;
  fetch: FetchLike;
  // Called for the Vision HTTP 400 and when every provider fails (Sentry).
  report: (error: Error) => void;
  isHidden: () => boolean;
  // Calls the callback when the tab is shown or hidden; returns an unsubscribe.
  watchVisibility: (cb: () => void) => () => void;
  random: () => number;
};

export function createMarketStore(deps: StoreDeps) {
  let snapshot: Snapshot = { markets: null, tickers: {}, source: null, failing: false, now: 0 };
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopWatching: (() => void) | null = null;
  let running = false;
  let inFlight = false;
  let visionSkipUntil = 0;
  let reportedStreak = false;
  let failures = 0;
  const reported400 = new Set<string>();

  const emit = (next: Partial<Snapshot>) => {
    snapshot = { ...snapshot, ...next };
    listeners.forEach((l) => l());
  };

  async function fetchTickers(markets: Market[]): Promise<{ tickers: Ticker[]; source: "vision" | "md" }> {
    if (Date.now() >= visionSkipUntil) {
      try {
        // One call per batch of 20 symbols; any failed batch fails the poll and the fallback quotes every market.
        const payloads = await Promise.all(
          visionUrls(markets).map((url) => getJson(deps.fetch, url, VISION_TIMEOUT_MS)),
        );
        const tickers = payloads.flatMap((payload) => normalizeVision(payload, markets));
        if (tickers.length === 0) throw new ProviderError("No usable tickers");
        return { tickers, source: "vision" };
      } catch (e) {
        visionSkipUntil = Date.now() + VISION_SKIP_MS + deps.random() * VISION_SKIP_JITTER_MS;
        // A 400 means one symbol is invalid, which fails the whole request.
        if (e instanceof ProviderError && e.status === 400 && !reported400.has(e.message)) {
          reported400.add(e.message);
          deps.report(e);
        }
      }
    }
    const tickers = parseMdResponse(await getJson(deps.fetch, MD_PATH, MD_TIMEOUT_MS));
    if (tickers.length === 0) throw new ProviderError("No usable tickers");
    return { tickers, source: "md" };
  }

  async function cycle() {
    inFlight = true;
    try {
      if (!snapshot.markets) {
        try {
          emit({ markets: await deps.loadMarkets(), now: Date.now() });
        } catch {
          failures += 1;
          emit({ failing: true, now: Date.now() });
          return;
        }
      }
      const markets = snapshot.markets ?? [];
      if (markets.length === 0) return;
      try {
        const { tickers, source } = await fetchTickers(markets);
        reportedStreak = false;
        const merged = { ...snapshot.tickers };
        // An older ticker (the other provider, a slow answer) never replaces a newer one.
        for (const t of tickers) {
          const known = merged[t.id];
          if (!known || t.ts >= known.ts) merged[t.id] = t;
        }
        failures = 0;
        emit({ tickers: merged, source, failing: false, now: Date.now() });
      } catch (e) {
        if (!reportedStreak) {
          reportedStreak = true;
          deps.report(e instanceof Error ? e : new Error("Market data unavailable"));
        }
        failures += 1;
        emit({ failing: true, now: Date.now() });
      }
    } finally {
      inFlight = false;
    }
  }

  // 5 s normally; while every provider keeps failing, 5, 10, 20, 40, then 60 s,
  // so a down upstream is not polled (and /md/v1/tickers not billed) every 5 s.
  function nextDelayMs() {
    return failures === 0 ? POLL_MS : FAILURE_BACKOFF_MS[Math.min(failures, FAILURE_BACKOFF_MS.length) - 1];
  }

  async function poll() {
    if (!running || inFlight) return;
    if (timer) clearTimeout(timer);
    timer = null;
    await cycle();
    if (running && !deps.isHidden()) timer = setTimeout(() => void poll(), nextDelayMs());
  }

  function onVisibility() {
    if (deps.isHidden()) {
      if (timer) clearTimeout(timer);
      timer = null;
    } else {
      void poll();
    }
  }

  function start() {
    running = true;
    stopWatching = deps.watchVisibility(onVisibility);
    if (!deps.isHidden()) void poll();
  }

  function stop() {
    running = false;
    if (timer) clearTimeout(timer);
    timer = null;
    stopWatching?.();
    stopWatching = null;
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
    getSnapshot: () => snapshot,
  };
}
