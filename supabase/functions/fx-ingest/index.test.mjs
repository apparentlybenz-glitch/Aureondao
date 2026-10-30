import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

// index.ts calls Deno.serve when imported; give it a stand-in first.
globalThis.Deno = { serve: () => {}, env: { get: () => undefined } };
const { createFxIngest, OXR_URL, OXR_TIMEOUT_MS } = await import("./index.ts");

// No test reaches the real Open Exchange Rates host: every fetch goes to the routes below.
const APP_ID = "oxr-app-id-0123456789abcdef";
const ENV = { SUPABASE_URL: "https://ref.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test", FX_INGEST_SECRET: "s3cret", OXR_APP_ID: APP_ID };
// A long decimal a float would round: forwarded byte for byte.
const OXR_BODY = '{\n  "disclaimer": "Usage subject to terms",\n  "timestamp": 1793872800,\n  "base": "USD",\n  "rates": {\n    "EUR": 0.921234567890123456789012345678901234567890,\n    "JPY": 152.3445\n  }\n}\n';
const INGEST_RESULT = { ts: "2026-11-04T15:00:00+00:00", accepted: 17, ignored: 0, skipped: [], entered: 2, settled: 1, settle_errors: 0 };

let calls;
let routes;
let env;
let logs;
let timeouts;
const realLog = console.log;

function make() {
  return createFxIngest({
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      for (const [prefix, fn] of routes) if (String(url).startsWith(prefix)) return fn(String(url), init);
      throw new Error(`unexpected ${url}`);
    },
    env: (k) => env[k],
    now: () => 0,
    timeout: (ms) => {
      timeouts.push(ms);
      return new AbortController().signal;
    },
  });
}
const post = (secret = "s3cret") =>
  new Request("https://fn/fx-ingest", { method: "POST", headers: { "x-aureonx-cron-secret": secret } });
const oxrCalls = () => calls.filter((c) => c.url.startsWith(OXR_URL));
const rpcCalls = (name) => calls.filter((c) => c.url === `${ENV.SUPABASE_URL}/rest/v1/rpc/${name}`);
const recorded = () => rpcCalls("fx_record_call").map((c) => JSON.parse(c.init.body));

beforeEach(() => {
  calls = [];
  env = { ...ENV };
  logs = [];
  timeouts = [];
  console.log = (...a) => logs.push(a.join(" "));
  routes = [
    [OXR_URL, () => new Response(OXR_BODY, { status: 200 })],
    [`${ENV.SUPABASE_URL}/rest/v1/rpc/ingest_fx_rates`, () => new Response(JSON.stringify(INGEST_RESULT), { status: 200 })],
    [`${ENV.SUPABASE_URL}/rest/v1/rpc/fx_record_call`, () => new Response("", { status: 204 })],
  ];
});
test.afterEach(() => {
  console.log = realLog;
});

test("refuses a wrong secret and non-POST requests, and calls nothing", async () => {
  const handle = make();
  assert.equal((await handle(post("nope"))).status, 401);
  assert.equal((await handle(new Request("https://fn/fx-ingest", { method: "POST" }))).status, 401);
  assert.equal((await handle(new Request("https://fn/fx-ingest"))).status, 405);
  assert.equal(calls.length, 0);
});

test("a missing OXR_APP_ID or FX_INGEST_SECRET is not_configured and calls nothing", async () => {
  for (const key of ["OXR_APP_ID", "FX_INGEST_SECRET"]) {
    env = { ...ENV, [key]: undefined };
    const r = await make()(post());
    assert.equal(r.status, 500);
    assert.deepEqual(await r.json(), { error: "not_configured" });
  }
  assert.equal(calls.length, 0);
});

test("200: exactly one upstream fetch with app_id and a 10 s timeout, body forwarded byte for byte", async () => {
  const r = await make()(post());
  assert.equal(r.status, 200);
  assert.equal(oxrCalls().length, 1);
  const u = new URL(oxrCalls()[0].url);
  assert.equal(`${u.origin}${u.pathname}`, OXR_URL);
  assert.equal(u.searchParams.get("app_id"), APP_ID);
  assert.equal(oxrCalls()[0].init.headers, undefined);
  assert.equal(OXR_TIMEOUT_MS, 10_000);
  assert.equal(timeouts[0], 10_000);

  const ingest = rpcCalls("ingest_fx_rates");
  assert.equal(ingest.length, 1);
  assert.equal(JSON.parse(ingest[0].init.body).p_body, OXR_BODY);
  assert.ok(ingest[0].init.body.includes("0.921234567890123456789012345678901234567890"));
  assert.deepEqual(recorded(), [{ p_status: 200, p_print_ts: INGEST_RESULT.ts }]);
  assert.deepEqual(await r.json(), { status: 200, ts: INGEST_RESULT.ts, accepted: 17, ignored: 0, skipped: 0, entered: 2, settled: 1, settle_errors: 0 });
});

test("non-200: exactly one upstream fetch, no ingest, the status is recorded", async () => {
  for (const status of [401, 429, 500, 503]) {
    calls = [];
    routes[0] = [OXR_URL, () => new Response(`{"error":true,"status":${status},"description":"app_id ${APP_ID}"}`, { status })];
    const r = await make()(post());
    assert.equal(r.status, 502);
    assert.deepEqual(await r.json(), { status, error: "upstream" });
    assert.equal(oxrCalls().length, 1);
    assert.equal(rpcCalls("ingest_fx_rates").length, 0);
    assert.deepEqual(recorded(), [{ p_status: status, p_print_ts: null }]);
  }
});

test("a timeout aborts the one call with no retry and records no status", async () => {
  routes[0] = [OXR_URL, async () => {
    throw Object.assign(new Error(`The signal timed out for ${OXR_URL}?app_id=${APP_ID}`), { name: "TimeoutError" });
  }];
  const r = await make()(post());
  assert.equal(r.status, 502);
  assert.deepEqual(await r.json(), { status: null, error: "timeout" });
  assert.equal(oxrCalls().length, 1);
  assert.equal(rpcCalls("ingest_fx_rates").length, 0);
  assert.deepEqual(recorded(), [{ p_status: null, p_print_ts: null }]);
});

test("a real abort through the signal is one call and a timeout", async () => {
  const handle = createFxIngest({
    fetch: (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).startsWith(OXR_URL)) {
        return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
      }
      return Promise.resolve(new Response("", { status: 204 }));
    },
    env: (k) => env[k],
    now: () => 0,
    timeout: (ms) => (ms === OXR_TIMEOUT_MS ? AbortSignal.timeout(5) : AbortSignal.timeout(ms)),
  });
  const r = await handle(post());
  assert.deepEqual(await r.json(), { status: null, error: "timeout" });
  assert.equal(oxrCalls().length, 1);
});

test("an ingest failure is reported without the upstream body and still records the status", async () => {
  routes[1] = [`${ENV.SUPABASE_URL}/rest/v1/rpc/ingest_fx_rates`, () => new Response('{"message":"FX_INVALID_TIMESTAMP"}', { status: 400 })];
  const r = await make()(post());
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), { status: 200, error: "Supabase rpc/ingest_fx_rates: HTTP 400" });
  assert.equal(oxrCalls().length, 1);
  assert.deepEqual(recorded(), [{ p_status: 200, p_print_ts: null }]);
});

test("no log line or response contains the app id or the upstream URL, on every path", async () => {
  const outcomes = [
    () => new Response(OXR_BODY, { status: 200 }),
    () => new Response(`bad key ${APP_ID}`, { status: 401 }),
    async () => { throw new TypeError(`fetch failed: ${OXR_URL}?app_id=${APP_ID}`); },
    async () => { throw Object.assign(new Error(`timed out ${APP_ID}`), { name: "TimeoutError" }); },
  ];
  const bodies = [];
  for (const fn of outcomes) {
    routes[0] = [OXR_URL, fn];
    bodies.push(await (await make()(post())).text());
  }
  assert.ok(logs.length >= outcomes.length);
  for (const line of [...logs, ...bodies]) {
    assert.ok(!line.includes(APP_ID), line);
    assert.ok(!line.includes("openexchangerates"), line);
    assert.ok(!line.includes("app_id"), line);
  }
});
