import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

// index.ts calls Deno.serve when imported; give it a stand-in first.
globalThis.Deno = { serve: () => {}, env: { get: () => undefined } };
const { createIngest, parseKucoin, parseVision, validQuote, FAILURE_SKIP_MS, RATE_LIMIT_SKIP_MS, MAX_ATTEMPTS, retryAfterMs, VISION_URL, VISION_BATCH, KUCOIN_URL } =
  await import("./index.ts");

const NOW = Date.UTC(2026, 9, 26, 13, 0, 0);
const markets = [
  { id: "BTC-USDT", vision_symbol: "BTCUSDT", kucoin_symbol: "BTC-USDT" },
  { id: "ETH-USDT", vision_symbol: "ETHUSDT", kucoin_symbol: "ETH-USDT" },
];
const ENV = { SUPABASE_URL: "https://ref.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test", PRICE_INGEST_SECRET: "s3cret" };
const visionBody = (over = {}) => [
  { symbol: "BTCUSDT", bidPrice: "84242.90000000", askPrice: "84243.00000000", closeTime: NOW - 500, ...over.BTCUSDT },
  { symbol: "ETHUSDT", bidPrice: "2318.70000000", askPrice: "2318.71000000", closeTime: NOW - 500, ...over.ETHUSDT },
];
const kucoinBody = () => ({ data: { time: NOW - 200, ticker: [
  { symbol: "BTC-USDT", buy: "84242.1", sell: "84242.2" },
  { symbol: "ETH-USDT", buy: "2318.6", sell: "2318.7" },
] } });
const res = (body, status = 200) => new Response(JSON.stringify(body), { status });

let calls;
let routes;
let now;
function make() {
  return createIngest({
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      for (const [prefix, fn] of routes) if (String(url).startsWith(prefix)) return fn(String(url), init);
      throw new Error(`unexpected ${url}`);
    },
    env: (k) => ENV[k],
    now: () => now,
    random: () => 0.5,
    sleep: async () => {},
  });
}
const post = (secret = "s3cret") =>
  new Request("https://fn/price-ingest", { method: "POST", headers: { "x-aureonx-cron-secret": secret } });
const ingested = () => JSON.parse(calls.find((c) => c.url.includes("/rpc/ingest_prices")).init.body).p_prices;

beforeEach(() => {
  calls = [];
  now = NOW;
  routes = [
    [`${ENV.SUPABASE_URL}/rest/v1/markets`, () => res(markets)],
    [`${ENV.SUPABASE_URL}/rest/v1/rpc/ingest_prices`, (_u, init) => res({ accepted: JSON.parse(init.body).p_prices.length, rejected: 0 })],
    [VISION_URL, () => res(visionBody())],
    [KUCOIN_URL, () => res(kucoinBody())],
  ];
});

test("refuses a missing or wrong secret and non-POST requests", async () => {
  const handle = make();
  assert.equal((await handle(post("nope"))).status, 401);
  assert.equal((await handle(new Request("https://fn/price-ingest", { method: "POST" }))).status, 401);
  assert.equal((await handle(new Request("https://fn/price-ingest"))).status, 405);
  assert.equal(calls.length, 0);
});

test("Vision quotes every market in one request; KuCoin is not called", async () => {
  const r = await make()(post());
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { accepted: 2, rejected: 0 });
  assert.equal(calls.filter((c) => c.url.startsWith(VISION_URL)).length, 1);
  assert.equal(calls.filter((c) => c.url.startsWith(KUCOIN_URL)).length, 0);
  assert.deepEqual(ingested()[0], {
    market_id: "BTC-USDT", bid: "84242.90000000", ask: "84243.00000000", source: "vision", ts: new Date(NOW - 500).toISOString(),
  });
});

test("exchange calls carry a signal and no headers or other options", async () => {
  routes[2][1] = () => res({}, 503);
  await make()(post());
  const exchange = calls.filter((c) => c.url.startsWith(VISION_URL) || c.url.startsWith(KUCOIN_URL));
  assert.ok(exchange.length > 0);
  for (const c of exchange) assert.deepEqual(Object.keys(c.init), ["signal"]);
});

test("a market Vision quotes invalidly comes from KuCoin", async () => {
  routes[2][1] = () => res(visionBody({ ETHUSDT: { askPrice: "2318.60000000" } })); // ask < bid
  await make()(post());
  assert.deepEqual(ingested().map((q) => `${q.market_id}:${q.source}`), ["BTC-USDT:vision", "ETH-USDT:kucoin"]);
});

test("Vision down: bounded retries, then KuCoin; Vision is skipped for 30 s", async () => {
  routes[2][1] = () => res({}, 503);
  const handle = make();
  await handle(post());
  assert.equal(calls.filter((c) => c.url.startsWith(VISION_URL)).length, MAX_ATTEMPTS);
  assert.deepEqual(ingested().map((q) => q.source), ["kucoin", "kucoin"]);

  calls = [];
  now += FAILURE_SKIP_MS - 1;
  await handle(post());
  assert.equal(calls.filter((c) => c.url.startsWith(VISION_URL)).length, 0);

  calls = [];
  now += 2;
  routes[2][1] = () => res(visionBody({ BTCUSDT: { closeTime: now }, ETHUSDT: { closeTime: now } }));
  await handle(post());
  assert.equal(calls.filter((c) => c.url.startsWith(VISION_URL)).length, 1);
});

test("a 429 or 418 from Vision is not retried: straight to KuCoin, Vision left alone for 60 s", async () => {
  for (const status of [429, 418]) {
    calls = [];
    now = NOW;
    routes[2][1] = () => res({}, status);
    const handle = make();
    await handle(post());
    assert.equal(calls.filter((c) => c.url.startsWith(VISION_URL)).length, 1, `status ${status}`);
    assert.deepEqual(ingested().map((q) => q.source), ["kucoin", "kucoin"]);

    calls = [];
    now += RATE_LIMIT_SKIP_MS - 1;
    await handle(post());
    assert.equal(calls.filter((c) => c.url.startsWith(VISION_URL)).length, 0);
    calls = [];
    now += 2;
    routes[2][1] = () => res(visionBody({ BTCUSDT: { closeTime: now }, ETHUSDT: { closeTime: now } }));
    await handle(post());
    assert.equal(calls.filter((c) => c.url.startsWith(VISION_URL)).length, 1);
  }
});

test("Retry-After sets how long Vision is left alone", async () => {
  routes[2][1] = () => new Response("{}", { status: 429, headers: { "retry-after": "120" } });
  const handle = make();
  await handle(post());
  calls = [];
  now += 119_000;
  await handle(post());
  assert.equal(calls.filter((c) => c.url.startsWith(VISION_URL)).length, 0);
  assert.equal(retryAfterMs("120", NOW), 120_000);
  assert.equal(retryAfterMs(new Date(NOW + 30_000).toUTCString(), NOW), 30_000);
  assert.equal(retryAfterMs("soon", NOW), null);
  assert.equal(retryAfterMs(null, NOW), null);
});

test("a retry after a 5xx waits at least 1 s plus jitter", async () => {
  routes[2][1] = () => res({}, 503);
  const waits = [];
  const handle = createIngest({
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      for (const [prefix, fn] of routes) if (String(url).startsWith(prefix)) return fn(String(url), init);
      throw new Error(`unexpected ${url}`);
    },
    env: (k) => ENV[k],
    now: () => now,
    random: () => 0.5,
    sleep: async (ms) => { waits.push(ms); },
  });
  await handle(post());
  assert.ok(waits.length >= 1 && waits.every((ms) => ms >= 1000 && ms < 1500), JSON.stringify(waits));
});

test("a 4xx other than 429 is not retried", async () => {
  routes[2][1] = () => res({ code: -1121, msg: "Invalid symbol." }, 400);
  await make()(post());
  assert.equal(calls.filter((c) => c.url.startsWith(VISION_URL)).length, 1);
});

test("both providers down: nothing is ingested and the answer is 502", async () => {
  routes[2][1] = () => res({}, 500);
  routes[3][1] = () => { throw new TypeError("network"); };
  const r = await make()(post());
  assert.equal(r.status, 502);
  assert.equal(calls.some((c) => c.url.includes("/rpc/ingest_prices")), false);
});

test("validQuote rejects bad numbers, crossed books and old or future timestamps", () => {
  assert.equal(validQuote("1.5", "1.6", NOW, NOW), true);
  assert.equal(validQuote("1.5", "1.5", NOW, NOW), true);
  for (const [bid, ask] of [["0", "1"], ["0.000", "1"], ["1.6", "1.5"], ["-1", "1"], ["1e3", "2e3"], ["NaN", "1"], [1.5, "1.6"], ["", "1"], [null, "1"]]) {
    assert.equal(validQuote(bid, ask, NOW, NOW), false, `${bid}/${ask}`);
  }
  assert.equal(validQuote("1", "2", NOW - 30_001, NOW), false);
  assert.equal(validQuote("1", "2", NOW + 5_001, NOW), false);
  assert.equal(validQuote("1", "2", Number.NaN, NOW), false);
});

test("parsers reject a body of the wrong shape", () => {
  assert.throws(() => parseVision({ code: 0 }, markets, NOW));
  assert.throws(() => parseKucoin({ data: null }, markets, NOW));
  assert.deepEqual(parseKucoin({ data: { time: NOW, ticker: [{ symbol: "BTC-USDT", buy: null, sell: "1" }] } }, markets, NOW), []);
});

// 40 markets: Vision is asked in two sequential calls of 20 symbols.
const many = Array.from({ length: 40 }, (_, i) => ({ id: `M${i}-USDT`, vision_symbol: `M${i}USDT`, kucoin_symbol: `M${i}-USDT` }));
const visionRows = (url) =>
  JSON.parse(new URL(url).searchParams.get("symbols")).map((symbol) => ({
    symbol, bidPrice: "1.00000000", askPrice: "1.00100000", closeTime: now - 500,
  }));
const kucoinAll = () => ({ data: { time: now - 200, ticker: many.map((m) => ({ symbol: m.kucoin_symbol, buy: "1.0", sell: "1.1" })) } });

test("40 markets: two Vision calls of 20 symbols each, one ingest with all 40 quotes", async () => {
  assert.equal(VISION_BATCH, 20);
  routes[0][1] = () => res(many);
  routes[2][1] = (url) => res(visionRows(url));
  const r = await make()(post());
  assert.equal(r.status, 200);
  const visionCalls = calls.filter((c) => c.url.startsWith(VISION_URL));
  assert.equal(visionCalls.length, 2);
  for (const c of visionCalls) assert.equal(JSON.parse(new URL(c.url).searchParams.get("symbols")).length, 20);
  assert.equal(calls.filter((c) => c.url.startsWith(KUCOIN_URL)).length, 0);
  assert.equal(ingested().length, 40);
  assert.ok(ingested().every((q) => q.source === "vision"));
});

test("a failing second batch keeps the first 20 Vision quotes, KuCoin fills the rest and Vision is skipped", async () => {
  routes[0][1] = () => res(many);
  let visionCount = 0;
  routes[2][1] = (url) => (++visionCount === 1 ? res(visionRows(url)) : res({}, 400));
  routes[3][1] = () => res(kucoinAll());
  const handle = make();
  await handle(post());
  const quotes = ingested();
  assert.equal(quotes.length, 40);
  assert.equal(quotes.filter((q) => q.source === "vision").length, 20);
  assert.equal(quotes.filter((q) => q.source === "kucoin").length, 20);

  calls = [];
  await handle(post());
  assert.equal(calls.filter((c) => c.url.startsWith(VISION_URL)).length, 0);
});

test("a 429 on the first batch sends no second Vision call", async () => {
  routes[0][1] = () => res(many);
  routes[2][1] = () => res({}, 429);
  routes[3][1] = () => res(kucoinAll());
  await make()(post());
  assert.equal(calls.filter((c) => c.url.startsWith(VISION_URL)).length, 1);
  assert.equal(ingested().length, 40);
});
