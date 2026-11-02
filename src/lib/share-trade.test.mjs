import assert from "node:assert/strict";
import { test } from "node:test";
import { formatBps, optionShareTrade, returnBps } from "./share-trade.ts";

const base = {
  id: "1", marketId: "BTC-USDT", direction: "rise", durationS: 90, premium: 10000n, fee: 10n,
  entryPrice: "50000.1", createdAt: "2026-11-02T00:00:00Z", expiresAt: 0, status: "settled",
  result: "win", settlePrice: "50010", payout: 11200n, settledAt: "2026-11-02T00:01:30Z",
};

test("percent and amount for a win and a loss", () => {
  const win = optionShareTrade(base, undefined);
  assert.equal(win.percent, "+12.00%");
  assert.equal(win.amount, "+12.00");
  assert.equal(win.side, "call");
  assert.equal(win.pair, "BTC/USDT");
  const loss = optionShareTrade({ ...base, result: "loss", payout: 0n, direction: "fall" }, undefined);
  assert.equal(loss.percent, "-100.00%");
  assert.equal(loss.amount, "-100.00");
  assert.equal(loss.win, false);
  assert.equal(loss.side, "put");
});

test("open, void and draw positions have no share card", () => {
  assert.equal(optionShareTrade({ ...base, status: "open", result: null, payout: null }, undefined), null);
  assert.equal(optionShareTrade({ ...base, status: "void", result: null, payout: 10010n }, undefined), null);
  assert.equal(optionShareTrade({ ...base, result: "draw", payout: 10000n }, undefined), null);
});

test("formatBps", () => {
  assert.equal(formatBps(returnBps(6n, 1000n)), "+0.60%");
  assert.equal(formatBps(0n), "0.00%");
  assert.equal(formatBps(-5n), "-0.05%");
});
