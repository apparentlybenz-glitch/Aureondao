import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_BUY_BUFFER_BPS, buyQtyFor, midPrice, checkQty, compareDecimal, feeCents, meetsMinimum, sellQtyFor, trimDecimal, valueCents } from "./spot-math.ts";

test("checkQty accepts plain decimals within the allowed places", () => {
  assert.deepEqual(checkQty("0.001", 5), { ok: true, qty: "0.001" });
  assert.deepEqual(checkQty("0.00100", 3), { ok: true, qty: "0.001" });
  assert.deepEqual(checkQty("12", 0), { ok: true, qty: "12" });
  assert.deepEqual(checkQty("12.", 0), { ok: true, qty: "12" });
  assert.deepEqual(checkQty("007.50", 1), { ok: true, qty: "7.5" });
});

test("checkQty rejects too many decimals, junk and zero", () => {
  assert.deepEqual(checkQty("0.000011", 5), { ok: false, reason: "decimals" });
  assert.deepEqual(checkQty("1.5", 0), { ok: false, reason: "decimals" });
  for (const bad of ["1e-3", "-1", ".5", " 1", "1 ", "0x10", "abc", "1,5"]) {
    assert.deepEqual(checkQty(bad, 5), { ok: false, reason: "format" }, bad);
  }
  assert.deepEqual(checkQty("", 5), { ok: false, reason: "empty" });
  assert.deepEqual(checkQty("0.000", 5), { ok: false, reason: "zero" });
});

test("valueCents and feeCents match the server's rounding (Part A test values)", () => {
  assert.equal(valueCents("0.001", "50000.10", "ceil"), 5001n);
  assert.equal(feeCents(5001n, 10), 6n);
  assert.equal(valueCents("0.0096", "50000.00", "floor"), 48000n);
  assert.equal(feeCents(48000n, 10), 48n);
  assert.equal(valueCents("0.0006", "50000.10000000", "ceil"), 3001n);
  assert.equal(feeCents(0n, 10), 0n);
});

test("meetsMinimum compares the unrounded value", () => {
  assert.equal(meetsMinimum("0.0001", "50000", 500n), true);
  assert.equal(meetsMinimum("0.00009", "50000", 500n), false);
  assert.equal(meetsMinimum("0.0001", "49999.99", 500n), false);
});

test("buyQtyFor finds the largest quantity whose cost plus fee fits", () => {
  // 949.93 at 50000.10 with 0.1%: 0.01898 BTC costs 949.01 + fee 0.95 = 949.96 > 949.93.
  const qty = buyQtyFor(94993n, "50000.10", 10, 5, 0);
  const cost = valueCents(qty, "50000.10", "ceil");
  assert.ok(cost + feeCents(cost, 10) <= 94993n);
  const next = (Number(qty) + 0.00001).toFixed(5);
  const nextCost = valueCents(next, "50000.10", "ceil");
  assert.ok(nextCost + feeCents(nextCost, 10) > 94993n);
  assert.equal(buyQtyFor(0n, "1", 10, 2, 0), "0");
  assert.equal(buyQtyFor(99n, "1", 0, 0, 0), "0");
  assert.equal(buyQtyFor(100n, "1", 0, 0, 0), "1");
});

test("buyQtyFor works for tiny prices with whole-unit quantities (PEPE)", () => {
  const qty = buyQtyFor(10000n, "0.00000441", 10, 0, 0);
  const cost = valueCents(qty, "0.00000441", "ceil");
  assert.ok(cost + feeCents(cost, 10) <= 10000n);
  assert.ok(Number(qty) > 22_000_000);
});

test("sellQtyFor rounds the share of the holding down", () => {
  assert.equal(sellQtyFor("0.019600000000000000", 50, 5), "0.0098");
  assert.equal(sellQtyFor("0.019600000000000000", 25, 5), "0.0049");
  assert.equal(sellQtyFor("0.00003", 50, 5), "0.00001");
  assert.equal(sellQtyFor("10", 100, 0), "10");
  assert.equal(sellQtyFor("0", 100, 3), "0");
});

test("compareDecimal and trimDecimal", () => {
  assert.equal(compareDecimal("0.02", "0.019600000000000000"), 1);
  assert.equal(compareDecimal("0.0196", "0.019600000000000000"), 0);
  assert.equal(compareDecimal("1", "1.5"), -1);
  assert.equal(trimDecimal("0.001000000000000000"), "0.001");
  assert.equal(trimDecimal("12.000"), "12");
  assert.equal(trimDecimal("12"), "12");
});

test("100% buy is sized at the ask plus 0.5 %, fee included, rounded down", () => {
  const ask = "50000.10";
  const qty = buyQtyFor(100000n, ask, 10, 5, MAX_BUY_BUFFER_BPS);
  // At ask x 1.005 = 50250.1005, 1000.00 USD buys 0.01988 BTC (cost 998.97 + fee 1.00).
  assert.equal(qty, "0.01988");
  const raised = "50250.1005";
  const cost = valueCents(qty, raised, "ceil");
  assert.ok(cost + feeCents(cost, 10) <= 100000n);
  const next = valueCents("0.01989", raised, "ceil");
  assert.ok(next + feeCents(next, 10) > 100000n);
  // Still fills if the server ask is up to 0.5 % above the shown one.
  const atServer = valueCents(qty, raised, "ceil");
  assert.ok(atServer + feeCents(atServer, 10) <= 100000n);
  // Without the buffer the same budget buys more.
  assert.equal(buyQtyFor(100000n, ask, 10, 5, 0), "0.01997");
  // DOGE, whole units: 1000 / (0.07768 x 1.005 x 1.001) = 12796.6, so 12796.
  assert.equal(buyQtyFor(100000n, "0.07768", 10, 0, MAX_BUY_BUFFER_BPS), "12796");
  const doge = valueCents("12796", "0.0780684", "ceil");
  assert.ok(doge + feeCents(doge, 10) <= 100000n);
});

test("100% sell uses the full holding with no buffer", () => {
  assert.equal(sellQtyFor("0.019600000000000000", 100, 5), "0.0196");
  assert.equal(sellQtyFor("12858.000000000000000000", 100, 0), "12858");
});

test("midPrice is exact", () => {
  assert.equal(midPrice("80410.00", "80410.01"), "80410.005");
  assert.equal(midPrice("0.00000440", "0.00000441"), "0.000004405");
  assert.equal(midPrice("2", "4"), "3");
});
