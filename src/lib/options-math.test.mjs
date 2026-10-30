import assert from "node:assert/strict";
import { test } from "node:test";
import { bpsToPercent, bpsToPercentText, estReturnCents, formatCountdown, minPremiumFloorCents, percentToBps } from "./options-math.ts";
import { feeCents } from "./spot-math.ts";

test("estReturnCents floors premium x rate / 10000 like the server", () => {
  assert.equal(estReturnCents(659000n, 600), 39540n); // 6590 USD at 6% -> 395.40
  assert.equal(estReturnCents(4900n, 600), 294n);
  assert.equal(estReturnCents(4999n, 600), 299n); // 299.94 floored
  assert.equal(estReturnCents(1n, 600), 0n);
});

test("the option fee rounds up like the server (Spot's rule)", () => {
  assert.equal(feeCents(659000n, 10), 659n);
  assert.equal(feeCents(4900n, 10), 5n); // 4.9 -> 5
});

test("bpsToPercent", () => {
  assert.equal(bpsToPercent(600), "6%");
  assert.equal(bpsToPercent(10), "0.1%");
  assert.equal(bpsToPercent(650), "6.5%");
  assert.equal(bpsToPercent(1), "0.01%");
  assert.equal(bpsToPercent(0), "0%");
});

test("percent text and percentToBps round trip", () => {
  assert.equal(bpsToPercentText(650), "6.5");
  assert.equal(bpsToPercentText(0), "0");
  for (const bps of [0, 1, 10, 600, 650, 1000, 100000]) {
    assert.equal(percentToBps(bpsToPercentText(bps)), bps);
  }
  assert.equal(percentToBps(" 6 "), 600);
  assert.equal(percentToBps("0.15"), 15);
  for (const bad of ["", ".5", "6.", "6.123", "-1", "1e2", "abc", "12345"]) {
    assert.equal(percentToBps(bad), null, bad);
  }
});

test("formatCountdown rounds up and stops at 0:00", () => {
  assert.equal(formatCountdown(30000), "0:30");
  assert.equal(formatCountdown(29001), "0:30");
  assert.equal(formatCountdown(299000), "4:59");
  assert.equal(formatCountdown(1), "0:01");
  assert.equal(formatCountdown(0), "0:00");
  assert.equal(formatCountdown(-5000), "0:00");
});

// The net of a win after the opening fee, exactly as the server computes it.
const net = (p, rate, fee) => (p * BigInt(rate)) / 10000n - (p * BigInt(fee) + 9999n) / 10000n;

test("minPremiumFloorCents is the smallest premium whose wins always net at least 1 cent", () => {
  assert.equal(minPremiumFloorCents(600, 10), 34n);
  assert.equal(net(34n, 600, 10), 1n);
  assert.equal(net(33n, 600, 10), 0n);
  assert.equal(minPremiumFloorCents(100, 10), 223n);
  assert.equal(minPremiumFloorCents(50000, 1000), 1n);
  assert.equal(minPremiumFloorCents(10, 10), null);
  assert.equal(minPremiumFloorCents(5, 10), null);
  for (const [rate, fee] of [[600, 10], [100, 10], [15, 10], [300, 250], [1000, 100]]) {
    const floor = minPremiumFloorCents(rate, fee);
    for (let p = floor; p < floor + 3000n; p++) assert.ok(net(p, rate, fee) >= 1n, `${rate}/${fee} at ${p}`);
  }
});
