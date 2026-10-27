// Shared upstream protection, framework-free.
// - Cool-down: a 418 or 429 from a host pauses every call to that host (tickers,
//   klines, depth, trades) until Retry-After, or 60 s when the header is absent
//   or not readable (cross-origin responses hide it without Access-Control-Expose-Headers).
// - Negative window: after a failed load the md routes do not call the same host
//   again for a short time, whatever key asked.
export const DEFAULT_COOLDOWN_MS = 60_000;
export const MAX_COOLDOWN_MS = 10 * 60_000;

// Retry-After is delta-seconds or an HTTP date. Null when missing or unusable.
export function parseRetryAfter(header: string | null | undefined, nowMs: number): number | null {
  if (!header) return null;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Math.min(Number(value) * 1000, MAX_COOLDOWN_MS);
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.min(Math.max(at - nowMs, 0), MAX_COOLDOWN_MS);
}

// Relative URLs (our own /md/v1 routes) share one pseudo-host.
export function hostOf(url: string): string {
  try {
    return new URL(url, "http://same-origin.invalid").host;
  } catch {
    return url;
  }
}

export function createCooldowns(now: () => number = Date.now) {
  const until = new Map<string, number>();
  return {
    // Starts (or extends) the cool-down for a host and returns its length.
    start(host: string, retryAfterMs: number | null): number {
      const ms = retryAfterMs !== null && retryAfterMs > 0 ? retryAfterMs : DEFAULT_COOLDOWN_MS;
      until.set(host, Math.max(until.get(host) ?? 0, now() + ms));
      return ms;
    },
    // Milliseconds left, 0 when the host is free.
    remaining(host: string): number {
      return Math.max((until.get(host) ?? 0) - now(), 0);
    },
    reset() {
      until.clear();
    },
  };
}

// One set per browser tab and per Worker isolate.
export const cooldowns = createCooldowns();

// After a failure, `blocked()` stays true for `windowMs`. One per upstream host.
export function createNegativeWindow(windowMs: number, now: () => number = Date.now) {
  let blockedUntil = 0;
  return {
    blocked: () => now() < blockedUntil,
    fail: () => {
      blockedUntil = now() + windowMs;
    },
    succeed: () => {
      blockedUntil = 0;
    },
  };
}
