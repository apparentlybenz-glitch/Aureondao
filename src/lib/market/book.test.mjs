import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeVisionDepth, normalizeVisionTrades, visionDepthUrl, visionTradesUrl } from "./book.ts";
import { startPolling } from "./poller.ts";
import { seededMarkets } from "./test/helpers.mjs";

const btc = seededMarkets().find((m) => m.id === "BTC-USDT");
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

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
