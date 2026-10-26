import assert from "node:assert/strict";
import { test } from "node:test";
import { buyQtyFor, checkQty, compareDecimal, feeCents, meetsMinimum, sellQtyFor, trimDecimal, valueCents } from "./spot-math.ts";

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
  const qty = buyQtyFor(94993n, "50000.10", 10, 5);
  const cost = valueCents(qty, "50000.10", "ceil");
  assert.ok(cost + feeCents(cost, 10) <= 94993n);
  const next = (Number(qty) + 0.00001).toFixed(5);
  const nextCost = valueCents(next, "50000.10", "ceil");
  assert.ok(nextCost + feeCents(nextCost, 10) > 94993n);
  assert.equal(buyQtyFor(0n, "1", 10, 2), "0");
  assert.equal(buyQtyFor(99n, "1", 0, 0), "0");
  assert.equal(buyQtyFor(100n, "1", 0, 0), "1");
});

test("buyQtyFor works for tiny prices with whole-unit quantities (PEPE)", () => {
  const qty = buyQtyFor(10000n, "0.00000441", 10, 0);
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
