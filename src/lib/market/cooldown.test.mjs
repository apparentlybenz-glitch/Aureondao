import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { DEFAULT_COOLDOWN_MS, MAX_COOLDOWN_MS, cooldowns, createCooldowns, createNegativeWindow, hostOf, parseRetryAfter } from "./cooldown.ts";
import { getJson } from "./http.ts";
import { ProviderError } from "./types.ts";

const SEC = 1000;
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });

beforeEach(() => cooldowns.reset());

test("parseRetryAfter reads seconds and dates, caps them, and ignores junk", () => {
  assert.equal(parseRetryAfter("30", 0), 30 * SEC);
  assert.equal(parseRetryAfter(new Date(45 * SEC).toUTCString(), 0), 45 * SEC);
  assert.equal(parseRetryAfter("99999999", 0), MAX_COOLDOWN_MS);
  assert.equal(parseRetryAfter("tomorrow", 0), null);
  assert.equal(parseRetryAfter(null, 0), null);
});

test("hostOf gives one host per upstream and one for our own routes", () => {
  assert.equal(hostOf("https://data-api.binance.vision/api/v3/depth?symbol=BTCUSDT"), "data-api.binance.vision");
  assert.equal(hostOf("/md/v1/tickers"), hostOf("/md/v1/klines?symbol=BTC-USDT"));
});

test("a cool-down lasts Retry-After, or 60 s without it", () => {
  let now = 1_000;
  const c = createCooldowns(() => now);
  assert.equal(c.start("a", 5 * SEC), 5 * SEC);
  assert.equal(c.start("b", null), DEFAULT_COOLDOWN_MS);
  assert.equal(c.remaining("a"), 5 * SEC);
  now += 5 * SEC;
  assert.equal(c.remaining("a"), 0);
  assert.equal(c.remaining("b"), DEFAULT_COOLDOWN_MS - 5 * SEC);
  assert.equal(c.remaining("never"), 0);
});

test("the negative window blocks after a failure until it succeeds or expires", () => {
  let now = 0;
  const w = createNegativeWindow(10 * SEC, () => now);
  assert.equal(w.blocked(), false);
  w.fail();
  assert.equal(w.blocked(), true);
  now += 10 * SEC;
  assert.equal(w.blocked(), false);
  w.fail();
  w.succeed();
  assert.equal(w.blocked(), false);
});

test("getJson: a 429 starts the host cool-down, and every call to that host then fails without a request", async () => {
  let requests = 0;
  const fetchImpl = async () => {
    requests += 1;
    return json({}, 429, { "retry-after": "20" });
  };
  await assert.rejects(getJson(fetchImpl, "https://data-api.binance.vision/api/v3/depth", 1000), (e) => e instanceof ProviderError && e.status === 429 && e.retryAfterMs === 20 * SEC);
  assert.equal(requests, 1);
  // Book, Trades, klines and tickers all share the host.
  for (const path of ["/api/v3/depth", "/api/v3/aggTrades", "/api/v3/klines", "/api/v3/ticker/24hr"]) {
    await assert.rejects(getJson(fetchImpl, `https://data-api.binance.vision${path}`, 1000), (e) => e instanceof ProviderError && e.status === 429);
  }
  assert.equal(requests, 1, "no request while cooling down");
  // Another host is unaffected.
  assert.deepEqual(await getJson(async () => json({ ok: 1 }), "https://api.kucoin.com/x", 1000), { ok: 1 });
});

test("getJson: a 418 without Retry-After cools the host for 60 s; other errors do not", async () => {
  await assert.rejects(getJson(async () => json({}, 418), "https://h.example/a", 1000), (e) => e.retryAfterMs === DEFAULT_COOLDOWN_MS);
  assert.ok(cooldowns.remaining("h.example") > 59 * SEC);
  cooldowns.reset();
  await assert.rejects(getJson(async () => json({}, 503), "https://h.example/a", 1000));
  await assert.rejects(getJson(async () => json({}, 400), "https://h.example/a", 1000));
  assert.equal(cooldowns.remaining("h.example"), 0);
});
