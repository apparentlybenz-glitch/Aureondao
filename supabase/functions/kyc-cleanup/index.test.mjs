import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

// index.ts calls Deno.serve when imported; give it a stand-in first.
globalThis.Deno = { serve: () => {}, env: { get: () => undefined } };
const { createCleanup, BUCKET } = await import("./index.ts");

const ENV = { SUPABASE_URL: "https://ref.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-key", KYC_CLEANUP_SECRET: "s3cret" };
const LIVE = "11111111-1111-4111-8111-111111111111";
const GONE = "22222222-2222-4222-8222-222222222222";

// A bucket as a map of full path -> true; list answers one level of it.
let objects;
let calls;
let env;

function listLevel(prefix) {
  const base = prefix ? `${prefix}/` : "";
  const seen = new Map();
  for (const path of Object.keys(objects)) {
    if (!path.startsWith(base)) continue;
    const [head, ...rest] = path.slice(base.length).split("/");
    seen.set(head, rest.length > 0 ? null : `id-${path}`);
  }
  return [...seen].sort(([a], [b]) => a.localeCompare(b)).map(([name, id]) => ({ name, id }));
}

function make() {
  return createCleanup({
    env: (k) => env[k],
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url: String(url), method: init.method, body, auth: init.headers.Authorization });
      const path = String(url).replace(ENV.SUPABASE_URL, "");
      if (path === `/storage/v1/object/list/${BUCKET}`) {
        const all = listLevel(body.prefix);
        return new Response(JSON.stringify(all.slice(body.offset, body.offset + body.limit)));
      }
      if (path === "/rest/v1/rpc/kyc_orphan_folders") {
        return new Response(JSON.stringify(body.p_folders.filter((f) => f === GONE)));
      }
      if (path === `/storage/v1/object/${BUCKET}` && init.method === "DELETE") {
        for (const p of body.prefixes) delete objects[p];
        return new Response(JSON.stringify(body.prefixes.map((name) => ({ name }))));
      }
      throw new Error(`unexpected ${init.method} ${path}`);
    },
  });
}

const post = (secret = "s3cret") =>
  new Request("https://fn/kyc-cleanup", { method: "POST", headers: secret ? { "x-aureonx-cron-secret": secret } : {} });

beforeEach(() => {
  env = { ...ENV };
  calls = [];
  objects = {
    [`${LIVE}/a.jpg`]: true,
    [`${GONE}/b.png`]: true,
    [`${GONE}/c.webp`]: true,
    [`${GONE}/nested/d.jpg`]: true,
    "not-a-user/e.jpg": true,
  };
});

test("rejects a missing or wrong secret and a non-POST", async () => {
  const handle = make();
  assert.equal((await handle(post(""))).status, 401);
  assert.equal((await handle(post("wrong"))).status, 401);
  assert.equal((await handle(new Request("https://fn/kyc-cleanup"))).status, 405);
  assert.equal(calls.length, 0);
});

test("answers not_configured without its secret", async () => {
  delete env.KYC_CLEANUP_SECRET;
  const res = await make()(post());
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: "not_configured" });
});

test("deletes every file of a deleted user's folder and leaves the others", async () => {
  const res = await make()(post());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { folders: 3, orphans: 1, removed: 3 });
  assert.deepEqual(Object.keys(objects).sort(), [`${LIVE}/a.jpg`, "not-a-user/e.jpg"].sort());
  assert.ok(calls.every((c) => c.auth === "Bearer service-key"));
});

test("pages through a folder longer than one list page", async () => {
  for (let i = 0; i < 1005; i++) objects[`${GONE}/f${String(i).padStart(4, "0")}.jpg`] = true;
  const res = await make()(post());
  assert.deepEqual(await res.json(), { folders: 3, orphans: 1, removed: 1008 });
  assert.equal(calls.filter((c) => c.method === "DELETE").length, 2);
  assert.ok(!Object.keys(objects).some((p) => p.startsWith(GONE)));
});

test("an upstream failure answers 500 and deletes nothing", async () => {
  const handle = createCleanup({ env: (k) => env[k], fetch: async () => new Response("nope", { status: 503 }) });
  const res = await handle(post());
  assert.equal(res.status, 500);
  assert.equal(Object.keys(objects).length, 5);
});
