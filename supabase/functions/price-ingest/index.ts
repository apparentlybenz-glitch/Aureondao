// price-ingest: writes the best bid/ask of every enabled market to price_snapshots
// through the service-role RPC ingest_prices. pg_cron (private.price_tick) fires it
// every 10 s, and only while a trading screen has asked for prices.
//
// Sources: Vision ticker/24hr for all markets in one request, then KuCoin allTickers
// for any market Vision did not quote validly. Exchange calls are plain GETs with a
// signal only. Each provider gets bounded retries with jittered backoff, and a failed
// provider is skipped for 30 s (per isolate). Keys are read from the environment and
// never logged. The database re-validates every price and enforces its own freshness.
// Single file on purpose: Deno needs ".ts" import paths, which the app tsconfig rejects.

export const VISION_URL = "https://data-api.binance.vision/api/v3/ticker/24hr";
export const KUCOIN_URL = "https://api.kucoin.com/api/v1/market/allTickers";
export const ATTEMPT_TIMEOUT_MS = 2500;
export const MAX_ATTEMPTS = 2;
export const FAILURE_SKIP_MS = 30_000;
export const MARKETS_TTL_MS = 60_000;
export const MAX_SOURCE_AGE_MS = 30_000;
export const MAX_FUTURE_MS = 5_000;

type Source = "vision" | "kucoin";
export type Market = { id: string; vision_symbol: string; kucoin_symbol: string };
export type Quote = { market_id: string; bid: string; ask: string; source: Source; ts: string };

export type Deps = {
  fetch: typeof fetch;
  env: (key: string) => string | undefined;
  now: () => number;
  random: () => number;
  sleep: (ms: number) => Promise<void>;
};

class UpstreamError extends Error {
  status: number | null;
  retryable: boolean;
  constructor(message: string, status: number | null, retryable: boolean) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

const DECIMAL = /^[0-9]{1,20}(\.[0-9]{1,18})?$/;

// Decimal string -> integer scaled by 1e18, so prices compare without floats.
function scaled(s: string): bigint {
  const [int, frac = ""] = s.split(".");
  return BigInt(int + frac.padEnd(18, "0"));
}

export function validQuote(bid: unknown, ask: unknown, tsMs: number, now: number): boolean {
  if (typeof bid !== "string" || typeof ask !== "string") return false;
  if (!DECIMAL.test(bid) || !DECIMAL.test(ask)) return false;
  if (!Number.isFinite(tsMs) || tsMs > now + MAX_FUTURE_MS || tsMs < now - MAX_SOURCE_AGE_MS) return false;
  const b = scaled(bid);
  return b > BigInt(0) && scaled(ask) >= b;
}

function quote(m: Market, bid: string, ask: string, source: Source, tsMs: number): Quote {
  return { market_id: m.id, bid, ask, source, ts: new Date(tsMs).toISOString() };
}

export function parseVision(body: unknown, markets: Market[], now: number): Quote[] {
  if (!Array.isArray(body)) throw new UpstreamError("Vision: unexpected body", 200, false);
  const bySymbol = new Map<string, Record<string, unknown>>();
  for (const row of body) {
    if (row && typeof row === "object" && typeof row.symbol === "string") bySymbol.set(row.symbol, row);
  }
  const out: Quote[] = [];
  for (const m of markets) {
    const r = bySymbol.get(m.vision_symbol);
    if (!r) continue;
    const ts = Number(r.closeTime);
    if (validQuote(r.bidPrice, r.askPrice, ts, now)) {
      out.push(quote(m, r.bidPrice as string, r.askPrice as string, "vision", ts));
    }
  }
  return out;
}

export function parseKucoin(body: unknown, markets: Market[], now: number): Quote[] {
  const data = (body as { data?: { time?: unknown; ticker?: unknown } } | null)?.data;
  if (!data || !Array.isArray(data.ticker)) throw new UpstreamError("KuCoin: unexpected body", 200, false);
  const ts = Number(data.time);
  const bySymbol = new Map<string, Record<string, unknown>>();
  for (const row of data.ticker) {
    if (row && typeof row === "object" && typeof row.symbol === "string") bySymbol.set(row.symbol, row);
  }
  const out: Quote[] = [];
  for (const m of markets) {
    const r = bySymbol.get(m.kucoin_symbol);
    // KuCoin: buy = best bid, sell = best ask.
    if (r && validQuote(r.buy, r.sell, ts, now)) out.push(quote(m, r.buy as string, r.sell as string, "kucoin", ts));
  }
  return out;
}

// Constant-time comparison of the shared cron secret.
function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export function createIngest(deps: Deps) {
  const skipUntil: Record<Source, number> = { vision: 0, kucoin: 0 };
  let markets: { list: Market[]; at: number } | null = null;

  // Plain GET to an exchange: a signal and nothing else, so no headers are ever sent.
  async function getExchange(url: string, name: string): Promise<unknown> {
    let last: UpstreamError | null = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) await deps.sleep(Math.floor(deps.random() * Math.min(2000, 300 * 2 ** attempt)));
      try {
        const res = await deps.fetch(url, { signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS) });
        if (res.ok) return await res.json();
        // 429 and 5xx may pass; any other 4xx (bad symbol, geo block) will not.
        last = new UpstreamError(`${name}: HTTP ${res.status}`, res.status, res.status === 429 || res.status >= 500);
      } catch (e) {
        last = new UpstreamError(`${name}: ${e instanceof Error ? e.name : "error"}`, null, true);
      }
      if (!last.retryable) break;
    }
    throw last ?? new UpstreamError(`${name}: failed`, null, false);
  }

  async function supabase(path: string, init: RequestInit = {}): Promise<unknown> {
    const url = deps.env("SUPABASE_URL");
    const key = deps.env("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) throw new Error("Supabase env missing");
    const res = await deps.fetch(`${url}${path}`, {
      ...init,
      headers: { apikey: key, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`Supabase ${path.split("?")[0]}: HTTP ${res.status}`);
    return res.json();
  }

  async function loadMarkets(): Promise<Market[]> {
    if (markets && deps.now() - markets.at < MARKETS_TTL_MS) return markets.list;
    try {
      const list = (await supabase("/rest/v1/markets?select=id,vision_symbol,kucoin_symbol&enabled=eq.true")) as Market[];
      markets = { list, at: deps.now() };
      return list;
    } catch (e) {
      if (markets) return markets.list; // keep the last list on a failed refresh
      throw e;
    }
  }

  async function fromProvider(source: Source, wanted: Market[], log: Record<string, unknown>): Promise<Quote[]> {
    if (wanted.length === 0) return [];
    if (deps.now() < skipUntil[source]) {
      log[source] = "skipped";
      return [];
    }
    try {
      const quotes =
        source === "vision"
          ? parseVision(
              await getExchange(`${VISION_URL}?symbols=${encodeURIComponent(JSON.stringify(wanted.map((m) => m.vision_symbol)))}`, "Vision"),
              wanted,
              deps.now(),
            )
          : parseKucoin(await getExchange(KUCOIN_URL, "KuCoin"), wanted, deps.now());
      log[source] = `ok:${quotes.length}`;
      return quotes;
    } catch (e) {
      skipUntil[source] = deps.now() + FAILURE_SKIP_MS;
      log[source] = e instanceof Error ? e.message : "failed";
      return [];
    }
  }

  return async function handle(req: Request): Promise<Response> {
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const secret = deps.env("PRICE_INGEST_SECRET");
    if (!secret) {
      console.log(JSON.stringify({ event: "price_ingest_misconfigured" }));
      return json({ error: "not_configured" }, 500);
    }
    if (!sameSecret(req.headers.get("x-aureonx-cron-secret") ?? "", secret)) {
      return json({ error: "unauthorized" }, 401);
    }

    const started = deps.now();
    const log: Record<string, unknown> = { event: "price_ingest" };
    try {
      const list = await loadMarkets();
      const quotes = await fromProvider("vision", list, log);
      const have = new Set(quotes.map((q) => q.market_id));
      quotes.push(...(await fromProvider("kucoin", list.filter((m) => !have.has(m.id)), log)));
      log.markets = list.length;
      log.quotes = quotes.length;
      if (quotes.length === 0) {
        log.ms = deps.now() - started;
        console.log(JSON.stringify(log));
        return json({ accepted: 0, rejected: 0 }, 502);
      }
      const result = (await supabase("/rest/v1/rpc/ingest_prices", {
        method: "POST",
        body: JSON.stringify({ p_prices: quotes }),
      })) as { accepted: number; rejected: number };
      Object.assign(log, result, { ms: deps.now() - started });
      console.log(JSON.stringify(log));
      return json(result);
    } catch (e) {
      Object.assign(log, { error: e instanceof Error ? e.message : "error", ms: deps.now() - started });
      console.log(JSON.stringify(log));
      return json({ error: "ingest_failed" }, 500);
    }
  };
}

Deno.serve(
  createIngest({
    fetch: (input, init) => fetch(input, init),
    env: (key) => Deno.env.get(key),
    now: () => Date.now(),
    random: () => Math.random(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }),
);
