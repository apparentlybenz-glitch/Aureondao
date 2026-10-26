import assert from "node:assert/strict";
import { test } from "node:test";
import { bpsToPercent, estReturnCents, formatCountdown } from "./options-math.ts";
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

test("formatCountdown rounds up and stops at 0:00", () => {
  assert.equal(formatCountdown(30000), "0:30");
  assert.equal(formatCountdown(29001), "0:30");
  assert.equal(formatCountdown(299000), "4:59");
  assert.equal(formatCountdown(1), "0:01");
  assert.equal(formatCountdown(0), "0:00");
  assert.equal(formatCountdown(-5000), "0:00");
});
