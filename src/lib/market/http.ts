import { cooldowns, hostOf, parseRetryAfter } from "./cooldown";
import { ProviderError } from "./types";

export type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

// A plain GET: only a signal is passed, never headers or credentials, so a
// cross-origin call stays a CORS "simple request" (no preflight). The timer
// covers reading the body too.
//
// A host that answered 418 or 429 is left alone (shared cool-down): while it
// lasts, no request is sent and the call fails at once.
export async function getJson(fetchImpl: FetchLike, url: string, timeoutMs: number): Promise<unknown> {
  const host = hostOf(url);
  const coolingMs = cooldowns.remaining(host);
  if (coolingMs > 0) {
    const blocked = new ProviderError(`Cooling down after HTTP 429 or 418 (${Math.ceil(coolingMs / 1000)} s left)`, 429);
    blocked.retryAfterMs = coolingMs;
    throw blocked;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const failure = new ProviderError(`HTTP ${res.status} ${body.slice(0, 200)}`.trim(), res.status);
      if (res.status === 418 || res.status === 429) {
        failure.retryAfterMs = cooldowns.start(host, parseRetryAfter(res.headers.get("retry-after"), Date.now()));
      }
      throw failure;
    }
    return await res.json();
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError(controller.signal.aborted ? `Timed out after ${timeoutMs} ms` : "Network error");
  } finally {
    clearTimeout(timer);
  }
}
