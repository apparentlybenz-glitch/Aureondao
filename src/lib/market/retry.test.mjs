import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_INLINE_WAIT_MS, MAX_RETRIES, RETRY_FLOOR_MS, isRetryable, retryDelayMs, withRetries } from "./retry.ts";
import { ProviderError } from "./types.ts";

const err = (status, retryAfterMs = null) => {
  const e = new ProviderError(`HTTP ${status}`, status);
  e.retryAfterMs = retryAfterMs;
  return e;
};

test("only timeouts, network errors, 5xx, 418 and 429 are retried", () => {
  for (const s of [null, 500, 502, 503, 418, 429]) assert.equal(isRetryable(err(s)), true, String(s));
  for (const s of [400, 401, 403, 404, 451]) assert.equal(isRetryable(err(s)), false, String(s));
  assert.equal(isRetryable(new Error("boom")), false);
});

test("the delay is at least 1 s and at least Retry-After, plus jitter", () => {
  assert.equal(retryDelayMs(err(503), 0), RETRY_FLOOR_MS);
  assert.ok(retryDelayMs(err(503), 1) > RETRY_FLOOR_MS);
  assert.equal(retryDelayMs(err(429, 3000), 0), 3000);
  assert.ok(retryDelayMs(err(503), 0.999) < RETRY_FLOOR_MS + 500);
});

function harness(errors) {
  const waits = [];
  let calls = 0;
  const attempt = async () => {
    calls += 1;
    const next = errors.shift();
    if (next) throw next;
    return "ok";
  };
  return { attempt, waits, calls: () => calls, deps: { sleep: async (ms) => { waits.push(ms); }, random: () => 0.5 } };
}

test("retries a transient failure at most twice, waiting between attempts", async () => {
  const h = harness([err(503), err(null)]);
  assert.equal(await withRetries(h.attempt, h.deps), "ok");
  assert.equal(h.calls(), 3);
  assert.equal(h.waits.length, 2);
  assert.ok(h.waits.every((ms) => ms >= RETRY_FLOOR_MS));

  const g = harness([err(503), err(503), err(503), err(503)]);
  await assert.rejects(withRetries(g.attempt, g.deps), (e) => e.retries === MAX_RETRIES);
  assert.equal(g.calls(), MAX_RETRIES + 1);
});

test("a 4xx is not retried", async () => {
  const h = harness([err(400)]);
  await assert.rejects(withRetries(h.attempt, h.deps));
  assert.equal(h.calls(), 1);
  assert.equal(h.waits.length, 0);
});

test("a short Retry-After is waited out; a long one (the host cool-down) is not retried", async () => {
  const short = harness([err(429, 2000)]);
  assert.equal(await withRetries(short.attempt, short.deps), "ok");
  assert.ok(short.waits[0] >= 2000);

  const long = harness([err(429, MAX_INLINE_WAIT_MS + 1)]);
  await assert.rejects(withRetries(long.attempt, long.deps), (e) => e.retries === 0);
  assert.equal(long.calls(), 1);
});
