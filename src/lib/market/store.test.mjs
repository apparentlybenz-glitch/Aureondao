import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { mock } from "node:test";
import { MD_PATH, POLL_MS, VISION_SKIP_JITTER_MS, VISION_SKIP_MS, VISION_TIMEOUT_MS, createMarketStore } from "./store.ts";
import { normalizeKucoin } from "./kucoin.ts";
import { isDelayed } from "./types.ts";
import { fixture, seededMarkets } from "./test/helpers.mjs";

const markets = seededMarkets();
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const flush = () => new Promise((resolve) => setImmediate(resolve));

// Lets the timers and promise chain run until idle.
async function settle() {
  for (let i = 0; i < 20; i++) await flush();
}

let calls;
let reports;
let hidden;
let visibilityCb;
let visionMode; // "ok" | "400" | "network" | "hang"
let mdOk;
let mdFresh; // stamp /md/v1 tickers with the mock clock instead of the recorded time
let store;

function makeFetch() {
  return (url, init) => {
    assert.deepEqual(Object.keys(init), ["signal"], "exchange calls pass only a signal");
    if (url.startsWith("https://data-api.binance.vision/")) {
      calls.push("vision");
      if (visionMode === "ok") return Promise.resolve(json(fixture("vision-24hr.json")));
      if (visionMode === "400") return Promise.resolve(json(fixture("vision-400.json"), 400));
      if (visionMode === "network") return Promise.reject(new TypeError("Failed to fetch"));
      return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }
    assert.equal(url, MD_PATH);
    calls.push("md");
    if (!mdOk) return Promise.resolve(json({ error: "market_data_unavailable" }, 502));
    const tickers = normalizeKucoin(fixture("kucoin-allTickers.json"), markets).map((t) => (mdFresh ? { ...t, ts: Date.now() } : t));
    return Promise.resolve(json({ source: "kucoin", tickers }));
  };
}

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  calls = [];
  reports = [];
  hidden = false;
  visibilityCb = null;
  visionMode = "ok";
  mdOk = true;
  mdFresh = false;
  store = createMarketStore({
    loadMarkets: async () => markets,
    fetch: makeFetch(),
    report: (e) => reports.push(e.message),
    isHidden: () => hidden,
    watchVisibility: (cb) => {
      visibilityCb = cb;
      return () => (visibilityCb = null);
    },
    random: () => 0.5,
  });
});

afterEach(() => mock.timers.reset());

test("polls Vision every 5 seconds with one request per poll", async () => {
  const off = store.subscribe(() => {});
  await settle();
  assert.deepEqual(calls, ["vision"]);
  assert.equal(store.getSnapshot().source, "vision");
  assert.equal(Object.keys(store.getSnapshot().tickers).length, 20);
  mock.timers.tick(POLL_MS);
  await settle();
  assert.deepEqual(calls, ["vision", "vision"]);
  off();
});

test("Vision HTTP 400 falls back to /md/v1 in the same poll and is reported once", async () => {
  visionMode = "400";
  const off = store.subscribe(() => {});
  await settle();
  assert.deepEqual(calls, ["vision", "md"]);
  assert.equal(store.getSnapshot().source, "md");
  assert.equal(Object.keys(store.getSnapshot().tickers).length, 20);
  assert.equal(reports.length, 1);
  assert.match(reports[0], /HTTP 400.*Invalid symbol/);
  off();
});

test("after Vision fails, /md/v1 keeps updating and Vision is skipped for 30 s plus jitter", async () => {
  visionMode = "network";
  const off = store.subscribe(() => {});
  await settle();
  const firstNow = store.getSnapshot().now;
  // Six more polls (30 s): Vision is not tried while skipped, md answers every poll.
  for (let i = 0; i < 6; i++) {
    mock.timers.tick(POLL_MS);
    await settle();
  }
  assert.equal(calls.filter((c) => c === "vision").length, 1);
  assert.equal(calls.filter((c) => c === "md").length, 7);
  assert.ok(store.getSnapshot().now - firstNow >= 6 * POLL_MS - 1);
  assert.equal(store.getSnapshot().source, "md");
  // Skip is 30 s + 2.5 s jitter (random 0.5): the next poll after 32.5 s tries Vision again.
  visionMode = "ok";
  mock.timers.tick(POLL_MS);
  await settle();
  assert.equal(calls.filter((c) => c === "vision").length, 2);
  assert.equal(store.getSnapshot().source, "vision");
  assert.ok(VISION_SKIP_MS + 0.5 * VISION_SKIP_JITTER_MS < 7 * POLL_MS);
  off();
});

test("a hanging Vision request times out after 4 s and md answers within one poll interval", async () => {
  visionMode = "hang";
  const off = store.subscribe(() => {});
  await settle();
  assert.deepEqual(calls, ["vision"]);
  assert.equal(store.getSnapshot().source, null);
  mock.timers.tick(VISION_TIMEOUT_MS);
  await settle();
  assert.deepEqual(calls, ["vision", "md"]);
  assert.equal(store.getSnapshot().source, "md");
  assert.ok(VISION_TIMEOUT_MS < POLL_MS);
  off();
});

test("when every provider fails it reports once per streak and keeps the old tickers", async () => {
  const off = store.subscribe(() => {});
  await settle();
  const before = store.getSnapshot().tickers;
  visionMode = "network";
  mdOk = false;
  mock.timers.tick(POLL_MS);
  await settle();
  mock.timers.tick(POLL_MS);
  await settle();
  assert.equal(store.getSnapshot().failing, true);
  assert.equal(store.getSnapshot().tickers, before);
  assert.equal(reports.length, 1);
  mdOk = true;
  mock.timers.tick(POLL_MS);
  await settle();
  assert.equal(store.getSnapshot().failing, false);
  off();
});

test("pauses while the tab is hidden and refreshes once on return", async () => {
  const off = store.subscribe(() => {});
  await settle();
  assert.equal(calls.length, 1);
  hidden = true;
  visibilityCb();
  mock.timers.tick(POLL_MS * 4);
  await settle();
  assert.equal(calls.length, 1);
  hidden = false;
  visibilityCb();
  await settle();
  assert.equal(calls.length, 2);
  off();
});

test("stops polling when the last subscriber leaves", async () => {
  const off = store.subscribe(() => {});
  await settle();
  off();
  mock.timers.tick(POLL_MS * 3);
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(visibilityCb, null);
});

test("when /md/v1 errors the last good tickers stay on screen and turn delayed on their own", async () => {
  visionMode = "network";
  mdFresh = true;
  const off = store.subscribe(() => {});
  await settle();
  const before = store.getSnapshot().tickers;
  assert.equal(Object.keys(before).length, 20);
  mdOk = false; // /md/v1 now answers 502
  for (let i = 0; i < 6; i++) {
    mock.timers.tick(POLL_MS);
    await settle();
  }
  let snap = store.getSnapshot();
  assert.equal(snap.failing, true);
  assert.equal(snap.tickers, before, "the table is not cleared or rebuilt");
  assert.ok(Object.values(snap.tickers).every((t) => !isDelayed(t.ts, snap.now)), "30 s old: not delayed yet");
  for (let i = 0; i < 8; i++) {
    mock.timers.tick(POLL_MS);
    await settle();
  }
  snap = store.getSnapshot();
  assert.equal(snap.tickers, before);
  assert.ok(Object.values(snap.tickers).every((t) => isDelayed(t.ts, snap.now)), "70 s old: delayed");
  mdOk = true;
  mdFresh = true;
  mock.timers.tick(POLL_MS);
  await settle();
  snap = store.getSnapshot();
  assert.equal(snap.failing, false);
  assert.ok(Object.values(snap.tickers).every((t) => !isDelayed(t.ts, snap.now)), "recovered");
  off();
});
