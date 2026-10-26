import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeVisionDepth, normalizeVisionTrades, visionDepthUrl, visionTradesUrl } from "./book.ts";
import {
  MD_KLINES_PATH,
  klinesRefreshDelay,
  kucoinKlinesUrl,
  loadKlines,
  normalizeKucoinKlines,
  normalizeVisionKlines,
  parseMdKlines,
  visionKlinesUrl,
} from "./klines.ts";
import { startPolling } from "./poller.ts";
import { seededMarkets } from "./test/helpers.mjs";

const btc = seededMarkets().find((m) => m.id === "BTC-USDT");
const res = (body, status = 200) => new Response(JSON.stringify(body), { status });
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

test("Vision klines: oldest first, epoch seconds, bad rows dropped", () => {
  const out = normalizeVisionKlines([
    [1793034240000, "80375.30", "80388.40", "80365.20", "80388.30", "3.8"],
    [1793034300000, "80388.30", "NaN", "80300.00", "80310.00", "1"],
    "junk",
  ]);
  assert.deepEqual(out, [{ time: 1793034240, open: "80375.30", high: "80388.40", low: "80365.20", close: "80388.30" }]);
  assert.throws(() => normalizeVisionKlines({ code: -1121 }));
});

test("KuCoin klines: columns reordered (open, close, high, low) and sorted oldest first", () => {
  const out = normalizeKucoinKlines({
    code: "200000",
    data: [
      ["1793034300", "80388.3", "80310.0", "80390.0", "80300.0", "1", "1"],
      ["1793034240", "80375.3", "80388.3", "80388.4", "80365.2", "3", "3"],
    ],
  });
  assert.deepEqual(out.map((c) => c.time), [1793034240, 1793034300]);
  assert.deepEqual(out[1], { time: 1793034300, open: "80388.3", high: "80390.0", low: "80300.0", close: "80310.0" });
  assert.throws(() => normalizeKucoinKlines({ data: null }));
});

test("kline URLs carry the market's own symbols", () => {
  assert.match(visionKlinesUrl(btc, "15m"), /symbol=BTCUSDT&interval=15m&limit=300$/);
  assert.match(kucoinKlinesUrl(btc, "4h", 1_793_034_300_000), /type=4hour&symbol=BTC-USDT&startAt=1788714300&endAt=1793034300$/);
});

test("loadKlines uses Vision, then /md/v1/klines when Vision fails", async () => {
  const calls = [];
  const candles = [[1793034240000, "1", "2", "0.5", "1.5", "9"]];
  let visionUp = true;
  const fetchImpl = async (url, init) => {
    calls.push({ url, keys: Object.keys(init) });
    if (url.startsWith("https://data-api.binance.vision")) return visionUp ? res(candles) : res({}, 503);
    return res({ source: "kucoin", stale: false, candles: [{ time: 1, open: "1", high: "2", low: "0.5", close: "1.5" }] });
  };
  assert.equal((await loadKlines(fetchImpl, btc, "1m")).source, "vision");
  visionUp = false;
  const fallback = await loadKlines(fetchImpl, btc, "1m");
  assert.equal(fallback.source, "md");
  assert.equal(calls.at(-1).url, `${MD_KLINES_PATH}?symbol=BTC-USDT&interval=1m`);
  for (const c of calls) assert.deepEqual(c.keys, ["signal"]);
  assert.deepEqual(parseMdKlines({ candles: [{ time: 1, open: "x" }] }), []);
});

test("klines refresh just after the candle closes, at least once a minute", () => {
  const now = Date.UTC(2026, 9, 26, 17, 0, 30);
  assert.equal(klinesRefreshDelay("1m", now, 0), 31_000);
  assert.equal(klinesRefreshDelay("4h", now, 0.999), 31_999);
});

test("depth and trades parse Vision payloads", () => {
  assert.match(visionDepthUrl(btc), /depth\?symbol=BTCUSDT&limit=20$/);
  assert.match(visionTradesUrl(btc), /aggTrades\?symbol=BTCUSDT&limit=30$/);
  const book = normalizeVisionDepth({ bids: [["80410.00", "5.5"], ["bad", "1"]], asks: [["80410.01", "0.2"]] });
  assert.deepEqual(book, { bids: [{ price: "80410.00", qty: "5.5" }], asks: [{ price: "80410.01", qty: "0.2" }] });
  const trades = normalizeVisionTrades([
    { a: 1, p: "80416.01", q: "0.002", T: 1000, m: false },
    { a: 2, p: "80416.00", q: "0.010", T: 2000, m: true },
    { a: 3, p: "0", q: "1", T: 3000, m: true },
  ]);
  assert.deepEqual(trades.map((t) => `${t.id}:${t.side}`), ["2:sell", "1:buy"]);
});

test("poller loads while visible, pauses when hidden, resumes at once on return", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let hidden = false;
  let onVis = () => {};
  let loads = 0;
  let fail = false;
  const states = [];
  const stop = startPolling({
    load: async () => {
      loads++;
      if (fail) throw new Error("down");
      return loads;
    },
    delayMs: () => 5000,
    isHidden: () => hidden,
    watchVisibility: (cb) => {
      onVis = cb;
      return () => {};
    },
    onChange: (s) => states.push(s),
  });
  await flush();
  assert.equal(loads, 1);
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(loads, 2);

  hidden = true;
  onVis();
  t.mock.timers.tick(20_000);
  await flush();
  assert.equal(loads, 2);

  hidden = false;
  fail = true;
  onVis();
  await flush();
  assert.equal(loads, 3);
  assert.deepEqual(states.at(-1), { data: null, failing: true });

  stop();
  t.mock.timers.tick(20_000);
  await flush();
  assert.equal(loads, 3);
});
