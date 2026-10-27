import { ProviderError } from "./types";

export const MAX_RETRIES = 2;
export const RETRY_FLOOR_MS = 1_000;
export const RETRY_JITTER_MS = 500;
// A longer Retry-After is not waited out inline; the host cool-down covers it.
export const MAX_INLINE_WAIT_MS = 5_000;

// Only transient failures: a timeout or network error (no status), 5xx, 418, 429.
// Other 4xx mean the request itself is wrong and would fail again.
export function isRetryable(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false;
  const s = error.status;
  return s === null || s >= 500 || s === 418 || s === 429;
}

// At least 1 s, at least Retry-After, plus jitter.
export function retryDelayMs(error: ProviderError, random: number): number {
  return Math.max(RETRY_FLOOR_MS, error.retryAfterMs ?? 0) + random * RETRY_JITTER_MS;
}

type Deps = { sleep: (ms: number) => Promise<void>; random: () => number };
const defaults: Deps = { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), random: Math.random };

// At most MAX_RETRIES retries of a retryable failure. Records the retries used.
export async function withRetries<T>(attempt: () => Promise<T>, deps: Deps = defaults): Promise<T> {
  let retries = 0;
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      const waitMs = error instanceof ProviderError ? (error.retryAfterMs ?? 0) : 0;
      if (retries >= MAX_RETRIES || !isRetryable(error) || waitMs > MAX_INLINE_WAIT_MS) {
        if (error instanceof ProviderError) error.retries = retries;
        throw error;
      }
      retries += 1;
      await deps.sleep(retryDelayMs(error as ProviderError, deps.random()));
    }
  }
}
