import assert from "node:assert/strict";
import { test } from "node:test";
import { fromUnits, generateLadder, groupLevels, toUnits, withTotals } from "./ladder.ts";

const base = { id: "EURUSD", mid: "1.08500", priceDecimals: 5, qtyDecimals: 0, levels: 20, minute: 29_000_000 };
const prices = (levels) => levels.map((l) => toUnits(l.price, 5));

test("units round-trip exactly", () => {
  assert.equal(toUnits("1.08500", 5), 108500n);
  assert.equal(fromUnits(108500n, 5), "1.08500");
  assert.equal(fromUnits(5n, 5), "0.00005");
  assert.equal(fromUnits(150n, 0), "150");
  assert.equal(toUnits("1e-7", 5), 0n);
});

test("generateLadder is deterministic: same inputs, same book; the minute and the id change it", () => {
  const a = generateLadder(base);
  assert.deepEqual(generateLadder(base), a);
  assert.notDeepEqual(generateLadder({ ...base, minute: base.minute + 1 }), a);
  assert.notDeepEqual(generateLadder({ ...base, id: "GBPUSD" }), a);
  assert.equal(a.asks.length, 20);
  assert.equal(a.bids.length, 20);
});

test("generateLadder prices are strictly monotonic and the book is not crossed", () => {
  for (let minute = 0; minute < 200; minute++) {
    const { bids, asks } = generateLadder({ ...base, minute });
    const a = prices(asks);
    const b = prices(bids);
    for (let i = 1; i < a.length; i++) assert.ok(a[i] > a[i - 1], `asks rise at ${i}, minute ${minute}`);
    for (let i = 1; i < b.length; i++) assert.ok(b[i] < b[i - 1], `bids fall at ${i}, minute ${minute}`);
    assert.ok(b[0] < a[0], "best bid below best ask");
    assert.ok(a[0] - b[0] <= 3n, "spread is at most 3 ticks");
    assert.ok(b[0] <= 108500n && a[0] >= 108500n, "the mid sits inside the spread");
  }
});

test("generateLadder uses the price and quantity decimals", () => {
  const { asks, bids } = generateLadder({ ...base, id: "USDJPY", mid: "150.000", priceDecimals: 3, qtyDecimals: 2 });
  for (const l of [...asks, ...bids]) {
    assert.match(l.price, /^\d+\.\d{3}$/);
    assert.match(l.qty, /^\d+\.\d{2}$/);
  }
  assert.deepEqual(generateLadder({ ...base, mid: "0.00000000", priceDecimals: 5 }), { bids: [], asks: [] });
});

test("withTotals is cumulative from the best level and its last total is the sum", () => {
  const levels = [
    { price: "1.00001", qty: "1.5" },
    { price: "1.00002", qty: "0.25" },
    { price: "1.00003", qty: "10" },
  ];
  const totals = withTotals(levels);
  assert.deepEqual(totals.map((l) => l.total), ["1.5", "1.75", "11.75"]);
  const book = generateLadder(base);
  const t = withTotals(book.asks);
  for (let i = 1; i < t.length; i++) assert.ok(toUnits(t[i].total, 18) > toUnits(t[i - 1].total, 18));
  const sum = book.asks.reduce((s, l) => s + toUnits(l.qty, 18), 0n);
  assert.equal(toUnits(t[t.length - 1].total, 18), sum);
});

test("groupLevels buckets by tick multiples: asks round up, bids round down, quantity is kept", () => {
  const asks = [
    { price: "1.08502", qty: "1" },
    { price: "1.08505", qty: "2" },
    { price: "1.08509", qty: "3" },
    { price: "1.08511", qty: "4" },
  ];
  const grouped = groupLevels(asks, "ask", 5, 10);
  assert.deepEqual(grouped, [
    { price: "1.08510", qty: "6" },
    { price: "1.08520", qty: "4" },
  ]);
  const bids = [
    { price: "1.08499", qty: "1" },
    { price: "1.08492", qty: "2" },
    { price: "1.08489", qty: "3" },
  ];
  assert.deepEqual(groupLevels(bids, "bid", 5, 10), [
    { price: "1.08490", qty: "3" },
    { price: "1.08480", qty: "3" },
  ]);
  assert.deepEqual(groupLevels(asks, "ask", 5, 1), asks.map((l) => ({ ...l, price: l.price })));
  // Totals survive grouping, and bucket prices are multiples of the step.
  const book = generateLadder(base);
  for (const multiplier of [1, 10, 100]) {
    const a = groupLevels(book.asks, "ask", 5, multiplier);
    const sum = (ls) => ls.reduce((s, l) => s + toUnits(l.qty, 18), 0n);
    assert.equal(sum(a), sum(book.asks));
    for (const l of a) assert.equal(toUnits(l.price, 5) % BigInt(multiplier), 0n);
    for (let i = 1; i < a.length; i++) assert.ok(toUnits(a[i].price, 5) > toUnits(a[i - 1].price, 5));
    const b = groupLevels(book.bids, "bid", 5, multiplier);
    for (let i = 1; i < b.length; i++) assert.ok(toUnits(b[i].price, 5) < toUnits(b[i - 1].price, 5));
  }
});
