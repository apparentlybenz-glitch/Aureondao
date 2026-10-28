// kyc-cleanup: removes the kyc-photos files of deleted users. pg_cron
// (private.kyc_cleanup_tick) posts here once a day with the shared secret header.
//
// It lists the top-level folders of the bucket (one per user id), asks the
// service-role RPC kyc_orphan_folders which of them have no auth.users row, and
// deletes every file under those folders through the Storage API (SQL cannot:
// storage.protect_delete blocks direct deletes). Other folders are never touched.
// Single file on purpose: Deno needs ".ts" import paths, which the app tsconfig rejects.

export const BUCKET = "kyc-photos";
export const PAGE_SIZE = 1000;
const TIMEOUT_MS = 10_000;

export type Deps = {
  fetch: typeof fetch;
  env: (key: string) => string | undefined;
};

type Entry = { name: string; id: string | null };

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

export function createCleanup(deps: Deps) {
  async function supabase(path: string, method: string, body: unknown): Promise<unknown> {
    const url = deps.env("SUPABASE_URL");
    const key = deps.env("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) throw new Error("Supabase env missing");
    const res = await deps.fetch(`${url}${path}`, {
      method,
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Supabase ${method} ${path}: HTTP ${res.status}`);
    return res.json();
  }

  // One level of a folder, every page. Folders come back with id null.
  async function list(prefix: string): Promise<Entry[]> {
    const out: Entry[] = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = (await supabase(`/storage/v1/object/list/${BUCKET}`, "POST", {
        prefix,
        limit: PAGE_SIZE,
        offset,
        sortBy: { column: "name", order: "asc" },
      })) as Entry[];
      out.push(...page);
      if (page.length < PAGE_SIZE) return out;
    }
  }

  // Every file path under a folder, including any nested folders.
  async function files(folder: string): Promise<string[]> {
    const out: string[] = [];
    for (const e of await list(folder)) {
      const path = `${folder}/${e.name}`;
      if (e.id === null) out.push(...(await files(path)));
      else out.push(path);
    }
    return out;
  }

  return async function handle(req: Request): Promise<Response> {
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const secret = deps.env("KYC_CLEANUP_SECRET");
    if (!secret) {
      console.log(JSON.stringify({ event: "kyc_cleanup_misconfigured" }));
      return json({ error: "not_configured" }, 500);
    }
    if (!sameSecret(req.headers.get("x-aureonx-cron-secret") ?? "", secret)) {
      return json({ error: "unauthorized" }, 401);
    }

    const log: Record<string, unknown> = { event: "kyc_cleanup" };
    try {
      const folders = (await list("")).filter((e) => e.id === null).map((e) => e.name);
      const orphans =
        folders.length === 0
          ? []
          : ((await supabase("/rest/v1/rpc/kyc_orphan_folders", "POST", { p_folders: folders })) as string[]);
      let removed = 0;
      for (const folder of orphans) {
        const paths = await files(folder);
        for (let i = 0; i < paths.length; i += PAGE_SIZE) {
          const batch = paths.slice(i, i + PAGE_SIZE);
          await supabase(`/storage/v1/object/${BUCKET}`, "DELETE", { prefixes: batch });
          removed += batch.length;
        }
      }
      Object.assign(log, { folders: folders.length, orphans: orphans.length, removed });
      console.log(JSON.stringify(log));
      return json({ folders: folders.length, orphans: orphans.length, removed });
    } catch (e) {
      Object.assign(log, { error: e instanceof Error ? e.message : "error" });
      console.log(JSON.stringify(log));
      return json({ error: "cleanup_failed" }, 500);
    }
  };
}

Deno.serve(
  createCleanup({
    fetch: (input, init) => fetch(input, init),
    env: (key) => Deno.env.get(key),
  }),
);
