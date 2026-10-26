import { ProviderError } from "./types";

export type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

// A plain GET: only a signal is passed, never headers or credentials, so a
// cross-origin call stays a CORS "simple request" (no preflight). The timer
// covers reading the body too.
export async function getJson(fetchImpl: FetchLike, url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ProviderError(`HTTP ${res.status} ${body.slice(0, 200)}`.trim(), res.status);
    }
    return await res.json();
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError(controller.signal.aborted ? `Timed out after ${timeoutMs} ms` : "Network error");
  } finally {
    clearTimeout(timer);
  }
}
