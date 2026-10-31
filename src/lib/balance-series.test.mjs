import assert from "node:assert/strict";
import { test } from "node:test";
import { balanceSeries } from "./balance-series.ts";

const row = (account, balance, held, at) => ({
  account,
  balance_after_cents: String(balance),
  held_after_cents: String(held),
  created_at: new Date(at).toISOString(),
});
const totals = (points) => points.map((p) => p.cents);

test("no ledger rows gives a flat line at the current total", () => {
  const points = balanceSeries([], [], 0, 100, 500n);
  assert.deepEqual(points, [
    { t: 0, cents: 500n },
    { t: 100, cents: 500n },
  ]);
});

test("the start sums each wallet's latest row before the window", () => {
  const points = balanceSeries([row("capital", 1000, 0, 0), row("spot", 200, 50, 0)], [], 10, 100, 1250n);
  assert.equal(points[0].cents, 1250n);
  assert.equal(points.at(-1).cents, 1250n);
  assert.equal(points.at(-1).t, 100);
});

test("rows at the same instant apply as one step and others carry forward", () => {
  const points = balanceSeries(
    [row("capital", 1000, 0, 0)],
    [row("capital", 400, 0, 20), row("spot", 600, 0, 20), row("spot", 550, 40, 50)],
    10,
    100,
    990n,
  );
  assert.deepEqual(totals(points), [1000n, 1000n, 1000n, 1000n, 990n, 990n, 990n]);
  assert.deepEqual(points.map((p) => p.t), [10, 20, 20, 50, 50, 100, 100]);
});

test("a wallet with no row before the window starts at 0", () => {
  const points = balanceSeries([], [row("options", 300, 0, 40)], 10, 100, 300n);
  assert.deepEqual(totals(points), [0n, 0n, 300n, 300n, 300n]);
});

test("a transfer between wallets draws no dip", () => {
  const points = balanceSeries(
    [row("capital", 1000, 0, 0)],
    [row("capital", 600, 0, 20), row("spot", 400, 0, 20)],
    10,
    100,
    1000n,
  );
  assert.ok(points.every((p) => p.cents === 1000n));
});

test("the last point is the current total even when it differs from the ledger", () => {
  const points = balanceSeries([], [row("capital", 300, 0, 40)], 10, 100, 350n);
  assert.equal(points.at(-2).cents, 300n);
  assert.equal(points.at(-1).cents, 350n);
});
