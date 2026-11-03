import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  changePercent,
  dayAgoPrint,
  durationParts,
  etParts,
  etStampText,
  fxDisplay,
  parseFeedStatus,
} from "./forex-math.ts";
import { forexTvSymbol } from "./forex-pairs.ts";
import { formatChange, formatPrice } from "./market/decimal.ts";

const messages = JSON.parse(readFileSync(new URL("../../messages/en.json", import.meta.url), "utf8"));
const fill = (template, vars) => template.replace(/\{(\w+)\}/g, (_, k) => vars[k]);

const HOUR = 3_600_000;
const at = (iso) => Date.parse(iso);
const iso = (ms) => new Date(ms).toISOString();

test("dayAgoPrint picks the print nearest to 24 h before the last one", () => {
  const last = "2026-11-03T21:00:01Z";
  const target = at(last) - 24 * HOUR;
  const rows = [
    { ts: iso(target - 20 * 60_000), price: "1.1000" },
    { ts: iso(target + 5 * 60_000), price: "1.1010" },
    { ts: iso(target + 25 * 60_000), price: "1.1020" },
  ];
  assert.equal(dayAgoPrint(rows, last).price, "1.1010");
});

test("dayAgoPrint accepts exactly 30 minutes away and refuses beyond", () => {
  const last = "2026-11-03T21:00:00Z";
  const target = at(last) - 24 * HOUR;
  assert.equal(dayAgoPrint([{ ts: iso(target + 30 * 60_000), price: "1" }], last).price, "1");
  assert.equal(dayAgoPrint([{ ts: iso(target - 30 * 60_000), price: "2" }], last).price, "2");
  assert.equal(dayAgoPrint([{ ts: iso(target + 30 * 60_000 + 1000), price: "3" }], last), null);
});

test("dayAgoPrint is null with no rows or a bad timestamp, and an exact tie takes the earlier print", () => {
  const last = "2026-11-03T21:00:00Z";
  const target = at(last) - 24 * HOUR;
  assert.equal(dayAgoPrint([], last), null);
  assert.equal(dayAgoPrint([{ ts: iso(target), price: "1" }], "nope"), null);
  const tie = [
    { ts: iso(target + 10 * 60_000), price: "late" },
    { ts: iso(target - 10 * 60_000), price: "early" },
  ];
  assert.equal(dayAgoPrint(tie, last).price, "early");
});

test("changePercent is exact decimal math, truncated to 4 decimals", () => {
  assert.equal(changePercent("1.10000", "1.00000"), "10.0000");
  assert.equal(changePercent("1.00000", "1.10000"), "-9.0909");
  assert.equal(changePercent("157.920", "157.500"), "0.2666");
  assert.equal(changePercent("1.1193", "1.1193"), "0.0000");
  assert.equal(changePercent("3945.40", "3900"), "1.1641");
  assert.equal(changePercent("1", "0"), null);
  assert.equal(changePercent("abc", "1"), null);
});

test("the header change reads like the market tables", () => {
  assert.equal(formatChange(changePercent("1.10000", "1.00000")), "+10.00%");
  assert.equal(formatChange(changePercent("1.00000", "1.10000")), "-9.09%");
  assert.equal(formatChange(changePercent("1.00001", "1.00000")), "0.00%");
});

test("prices format to the instrument's decimals", () => {
  assert.equal(formatPrice("1.1193", 5), "1.11930"); // fx
  assert.equal(formatPrice("157.92", 3), "157.920"); // JPY pairs
  assert.equal(formatPrice("3945.4", 2), "3,945.40"); // XAU-USD
  assert.equal(formatPrice("50.466", 3), "50.466"); // XAG-USD
  assert.equal(formatPrice("0.699614", 5), "0.69961");
});

test("etParts reads New York time across the clock change", () => {
  // Fx reopens Sunday 17:00 New York: 22:00 UTC in winter, 21:00 UTC in summer.
  assert.deepEqual(etParts("2026-11-08T22:00:00+00:00"), { weekday: "Sunday", time: "5:00 PM" });
  assert.deepEqual(etParts("2026-07-12T21:00:00+00:00"), { weekday: "Sunday", time: "5:00 PM" });
  // Metals reopen 18:00 New York on weekdays.
  assert.deepEqual(etParts("2026-11-03T23:00:00+00:00"), { weekday: "Tuesday", time: "6:00 PM" });
  assert.equal(etParts("nope"), null);
  assert.equal(etStampText("2026-11-03T22:00:00Z"), "Nov 3, 5:00 PM");
  assert.equal(etStampText("nope"), "--");
});

test("the closed wording", () => {
  const at = etParts("2026-11-08T22:00:00+00:00");
  assert.equal(
    fill(messages.Forex.closed, at),
    "Forex is closed. It opens again Sunday at 5:00 PM ET.",
  );
});

test("the crossing wording", () => {
  const at = etParts("2026-11-06T22:00:00+00:00");
  assert.equal(
    fill(messages.Forex.crossing, at),
    "A new position cannot finish before Forex closes at 5:00 PM ET. Try again when it reopens.",
  );
  assert.equal(messages.Forex.errors.PRICE_STALE, "Prices are updating. Try again in a minute.");
});

test("the feed status parses and rejects odd bodies", () => {
  const body = {
    fx: { closed: false, opens_at: null, closes_at: "2026-11-06T22:00:00+00:00" },
    metal: { closed: true, opens_at: "2026-11-03T23:00:00+00:00", closes_at: "2026-11-04T22:00:00+00:00" },
    demand_until: "2026-11-03T22:00:00+00:00",
  };
  assert.deepEqual(parseFeedStatus(body), {
    fx: { closed: false, opensAt: null, closesAt: "2026-11-06T22:00:00+00:00" },
    metal: { closed: true, opensAt: "2026-11-03T23:00:00+00:00", closesAt: "2026-11-04T22:00:00+00:00" },
  });
  assert.equal(parseFeedStatus(null), null);
  assert.equal(parseFeedStatus({ fx: { closed: false } }), null);
  assert.equal(parseFeedStatus({ fx: { closed: "no" }, metal: { closed: false } }), null);
});

test("durations and instrument ids", () => {
  assert.deepEqual(durationParts(3600), { unit: "hours", value: 1 });
  assert.deepEqual(durationParts(14400), { unit: "hours", value: 4 });
  assert.deepEqual(durationParts(5400), { unit: "minutes", value: 90 });
  assert.equal(fxDisplay("EUR-USD"), "EUR/USD");
});

test("TradingView symbols for the 13 enabled instruments", () => {
  const ids = [
    "EUR-USD", "GBP-USD", "USD-JPY", "USD-CHF", "USD-CAD", "AUD-USD", "NZD-USD",
    "EUR-GBP", "EUR-JPY", "GBP-JPY", "AUD-JPY", "XAU-USD", "XAG-USD",
  ];
  assert.deepEqual(
    ids.map(forexTvSymbol),
    [
      "FX:EURUSD", "FX:GBPUSD", "FX:USDJPY", "FX:USDCHF", "FX:USDCAD", "FX:AUDUSD", "FX:NZDUSD",
      "FX:EURGBP", "FX:EURJPY", "FX:GBPJPY", "FX:AUDJPY", "OANDA:XAUUSD", "OANDA:XAGUSD",
    ],
  );
});
