// fx-ingest: fetches the Open Exchange Rates latest.json table once and hands the
// raw body to the service-role RPC ingest_fx_rates. pg_cron (private.fx_tick)
// fires it at most once per clock hour, only while Forex has demand and is not
// fully closed; the claimed hour is the call's negative cache, so there are no
// retries here (an exception to the usual bounded retry rule).
//
// The body is forwarded as text, never parsed, so no rate passes through a
// JavaScript float. The app id (OXR_APP_ID) is read from the environment and is
// never logged: no URL, key or upstream error text is written anywhere, only the
// HTTP status. Each call's status and time are recorded through fx_record_call.
// Single file on purpose: Deno needs ".ts" import paths, which the app tsconfig rejects.

export const OXR_URL = "https://openexchangerates.org/api/latest.json";
export const OXR_TIMEOUT_MS = 10_000;
const SUPABASE_TIMEOUT_MS = 4000;

export type Deps = {
  fetch: typeof fetch;
  env: (key: string) => string | undefined;
  now: () => number;
  // An abort signal that fires after ms (AbortSignal.timeout in production).
  timeout: (ms: number) => AbortSignal;
};

// Constant-time comparison of the shared cron secret.
function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export function createFxIngest(deps: Deps) {
  async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    const url = deps.env("SUPABASE_URL");
    const key = deps.env("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) throw new Error("Supabase env missing");
    const res = await deps.fetch(`${url}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: { apikey: key, "Content-Type": "application/json" },
      body: JSON.stringify(args),
      signal: deps.timeout(SUPABASE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Supabase rpc/${name}: HTTP ${res.status}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  // Recording is best effort: a failure here must not hide the call's outcome.
  async function record(status: number | null, printTs: string | null, log: Record<string, unknown>) {
    try {
      await rpc("fx_record_call", { p_status: status, p_print_ts: printTs });
    } catch (e) {
      log.record = e instanceof Error ? e.message : "failed";
    }
  }

  return async function handle(req: Request): Promise<Response> {
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const secret = deps.env("FX_INGEST_SECRET");
    const appId = deps.env("OXR_APP_ID");
    if (!secret || !appId) {
      console.log(JSON.stringify({ event: "fx_ingest_misconfigured" }));
      return json({ error: "not_configured" }, 500);
    }
    if (!sameSecret(req.headers.get("x-aureonx-cron-secret") ?? "", secret)) {
      return json({ error: "unauthorized" }, 401);
    }

    const started = deps.now();
    const log: Record<string, unknown> = { event: "fx_ingest" };
    const done = (body: Record<string, unknown>, status: number) => {
      Object.assign(log, body, { ms: deps.now() - started });
      console.log(JSON.stringify(log));
      return json(body, status);
    };

    // One attempt: a plain GET with a signal only, no headers.
    let res: Response;
    try {
      res = await deps.fetch(`${OXR_URL}?app_id=${encodeURIComponent(appId)}`, { signal: deps.timeout(OXR_TIMEOUT_MS) });
    } catch (e) {
      // Only the error name: a message can carry the request URL.
      const reason = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? "timeout" : "network";
      await record(null, null, log);
      return done({ status: null, error: reason }, 502);
    }
    if (!res.ok) {
      await record(res.status, null, log);
      return done({ status: res.status, error: "upstream" }, 502);
    }

    let body: string;
    try {
      body = await res.text();
    } catch {
      await record(res.status, null, log);
      return done({ status: res.status, error: "read_failed" }, 502);
    }

    try {
      const result = (await rpc("ingest_fx_rates", { p_body: body })) as Record<string, unknown>;
      await record(res.status, typeof result?.ts === "string" ? result.ts : null, log);
      return done({
        status: res.status,
        ts: result?.ts ?? null,
        accepted: result?.accepted ?? null,
        ignored: result?.ignored ?? null,
        skipped: Array.isArray(result?.skipped) ? result.skipped.length : null,
        entered: result?.entered ?? null,
        settled: result?.settled ?? null,
        settle_errors: result?.settle_errors ?? null,
      }, 200);
    } catch (e) {
      await record(res.status, null, log);
      return done({ status: res.status, error: e instanceof Error ? e.message : "ingest_failed" }, 500);
    }
  };
}

Deno.serve(
  createFxIngest({
    fetch: (input, init) => fetch(input, init),
    env: (key) => Deno.env.get(key),
    now: () => Date.now(),
    timeout: (ms) => AbortSignal.timeout(ms),
  }),
);
