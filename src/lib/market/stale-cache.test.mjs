import assert from "node:assert/strict";
import { test } from "node:test";
import { createStaleCache } from "./stale-cache.ts";
import { ProviderError } from "./types.ts";

const SECOND = 1_000;

// A cache on a fake clock with a scriptable upstream.
function setup(overrides = {}) {
  const state = { now: 1_000_000, calls: 0, fail: false, version: 1, errors: [] };
  const get = createStaleCache({
    load: async () => {
      state.calls++;
      if (state.fail) throw new ProviderError("KuCoin: HTTP 429", 429);
      return { version: state.version };
    },
    ttlMs: 5 * SECOND,
    negativeTtlMs: 10 * SECOND,
    maxStaleMs: 60 * SECOND,
    now: () => state.now,
    onError: (error, info) => state.errors.push({ status: error.status, ...info }),
    ...overrides,
  });
  return { state, get, advance: (ms) => (state.now += ms) };
}

test("upstream fails with a fresh cache: 200 with the old data, marked stale", async () => {
  const { state, get, advance } = setup();
  assert.deepEqual(await get(), { value: { version: 1 }, stale: false });
  advance(6 * SECOND);
  state.fail = true;
  state.version = 2;
  assert.deepEqual(await get(), { value: { version: 1 }, stale: true });
  assert.deepEqual(state.errors, [{ status: 429, servedStale: true }]);
});

test("the negative window keeps the upstream from being called while it is failing", async () => {
  const { state, get, advance } = setup();
  await get();
  advance(6 * SECOND);
  state.fail = true;
  await get();
  const calls = state.calls;
  for (let i = 0; i < 5; i++) {
    advance(1 * SECOND);
    assert.equal((await get()).stale, true);
  }
  assert.equal(state.calls, calls, "no upstream call inside the 10 s window");
  advance(5 * SECOND); // 11 s since the failure: tried again
  await get();
  assert.equal(state.calls, calls + 1);
});

test("upstream fails with a 61 second old cache: the error, never old data", async () => {
  const { state, get, advance } = setup();
  await get();
  advance(61 * SECOND);
  state.fail = true;
  await assert.rejects(get(), (e) => e instanceof ProviderError && e.status === 429);
  assert.deepEqual(state.errors, [{ status: 429, servedStale: false }]);
  // Still inside the negative window: the same error, with no new upstream call.
  const calls = state.calls;
  advance(2 * SECOND);
  await assert.rejects(get(), ProviderError);
  assert.equal(state.calls, calls);
});

test("a 60 second old cache is still served and a 60.001 second one is not", async () => {
  const { state, get, advance } = setup();
  await get();
  advance(60 * SECOND);
  state.fail = true;
  assert.equal((await get()).stale, true);
  advance(11 * SECOND); // window over, cache now 71 s old
  await assert.rejects(get(), ProviderError);
});

test("a successful refetch replaces the cache", async () => {
  const { state, get, advance } = setup();
  await get();
  advance(6 * SECOND);
  state.fail = true;
  assert.equal((await get()).value.version, 1);
  advance(11 * SECOND);
  state.fail = false;
  state.version = 2;
  assert.deepEqual(await get(), { value: { version: 2 }, stale: false });
  // The next failure serves the new data, not the old.
  advance(6 * SECOND);
  state.fail = true;
  assert.deepEqual(await get(), { value: { version: 2 }, stale: true });
});

test("concurrent callers share one load", async () => {
  const { state, get } = setup();
  const results = await Promise.all([get(), get(), get()]);
  assert.equal(state.calls, 1);
  assert.ok(results.every((r) => r.value.version === 1));
});

test("with no good value yet, a failure rethrows the real error", async () => {
  const { state, get } = setup();
  state.fail = true;
  await assert.rejects(get(), (e) => e.message === "KuCoin: HTTP 429");
});

test("an unbounded maxStaleMs keeps the last value for good (the markets list)", async () => {
  const { state, get, advance } = setup({ maxStaleMs: Number.POSITIVE_INFINITY });
  await get();
  state.fail = true;
  for (let i = 0; i < 4; i++) {
    advance(3_600 * SECOND);
    assert.equal((await get()).stale, true);
  }
});
