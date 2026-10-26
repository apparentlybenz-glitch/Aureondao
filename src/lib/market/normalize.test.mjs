import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeKucoin, parseMdResponse } from "./kucoin.ts";
import { normalizeVision, visionUrl } from "./vision.ts";
import { fixture, seededMarkets } from "./test/helpers.mjs";

const markets = seededMarkets();

test("normalizeVision maps the recorded 24hr response", () => {
  const raw = fixture("vision-24hr.json");
  const tickers = normalizeVision(raw, markets);
  assert.equal(tickers.length, 20);
  const btcRaw = raw.find((r) => r.symbol === "BTCUSDT");
  const btc = tickers.find((t) => t.id === "BTC-USDT");
  assert.deepEqual(btc, {
    id: "BTC-USDT",
    last: btcRaw.lastPrice,
    bid: btcRaw.bidPrice,
    ask: btcRaw.askPrice,
    changePct: btcRaw.priceChangePercent,
    quoteVolume: btcRaw.quoteVolume,
    ts: btcRaw.closeTime,
  });
  for (const t of tickers) {
    for (const k of ["last", "bid", "ask", "changePct", "quoteVolume"]) assert.equal(typeof t[k], "string");
  }
});

test("normalizeVision drops unusable rows and unknown symbols", () => {
  const raw = fixture("vision-24hr.json");
  raw[0].bidPrice = "0.00000000";
  raw[1].lastPrice = "1E-7";
  raw[2].closeTime = null;
  raw.push({ ...raw[3], symbol: "NOTSEEDEDUSDT" });
  const ids = normalizeVision(raw, markets).map((t) => t.id);
  assert.equal(ids.length, 17);
  assert.ok(!ids.includes("BTC-USDT"));
});

test("normalizeVision rejects a non-array payload (the 400 body)", () => {
  assert.throws(() => normalizeVision(fixture("vision-400.json"), markets), /Unexpected ticker payload/);
});

test("visionUrl sends one request with a JSON symbols list", () => {
  const url = new URL(visionUrl(markets));
  assert.equal(url.origin + url.pathname, "https://data-api.binance.vision/api/v3/ticker/24hr");
  const symbols = JSON.parse(url.searchParams.get("symbols"));
  assert.equal(symbols.length, 20);
  assert.equal(symbols[0], "BTCUSDT");
});

test("normalizeKucoin maps buy to bid, sell to ask and converts the change rate", () => {
  const raw = fixture("kucoin-allTickers.json");
  const tickers = normalizeKucoin(raw, markets);
  assert.equal(tickers.length, 20);
  const rawEna = raw.data.ticker.find((r) => r.symbol === "ENA-USDT");
  const ena = tickers.find((t) => t.id === "ENA-USDT");
  assert.equal(ena.bid, rawEna.buy);
  assert.equal(ena.ask, rawEna.sell);
  assert.equal(ena.last, rawEna.last);
  assert.equal(ena.quoteVolume, rawEna.volValue);
  assert.equal(ena.ts, raw.data.time);
  assert.equal(Number(ena.changePct), Number(rawEna.changeRate) * 100);
});

test("normalizeKucoin leaves out pairs that are not enabled markets", () => {
  const raw = fixture("kucoin-allTickers.json");
  assert.ok(raw.data.ticker.some((r) => r.symbol === "USDC-USDT"));
  const ids = normalizeKucoin(raw, markets).map((t) => t.id);
  assert.ok(!ids.includes("USDC-USDT") && !ids.includes("XMR-USDT"));
});

test("normalizeKucoin drops a row with a null side instead of inventing one", () => {
  const raw = fixture("kucoin-allTickers.json");
  raw.data.ticker.find((r) => r.symbol === "SOL-USDT").buy = null;
  raw.data.ticker.find((r) => r.symbol === "ETH-USDT").sell = "0";
  const ids = normalizeKucoin(raw, markets).map((t) => t.id);
  assert.equal(ids.length, 18);
  assert.ok(!ids.includes("SOL-USDT") && !ids.includes("ETH-USDT"));
});

test("normalizeKucoin rejects a payload without data", () => {
  assert.throws(() => normalizeKucoin({ code: "400100" }, markets), /Unexpected ticker payload/);
});

test("parseMdResponse round-trips normalized tickers and drops bad rows", () => {
  const tickers = normalizeKucoin(fixture("kucoin-allTickers.json"), markets);
  assert.deepEqual(parseMdResponse({ source: "kucoin", tickers }), tickers);
  const bad = [{ ...tickers[0], bid: 5 }, tickers[1]];
  assert.deepEqual(parseMdResponse({ tickers: bad }), [tickers[1]]);
  assert.throws(() => parseMdResponse({ error: "x" }), /Unexpected ticker payload/);
});
