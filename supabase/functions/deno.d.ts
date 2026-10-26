// The few Deno globals the Edge Functions use, so `pnpm typecheck` and lint
// cover supabase/functions/ under the app's tsconfig. Not deployed.
declare namespace Deno {
  function serve(handler: (req: Request) => Response | Promise<Response>): unknown;
  const env: { get(key: string): string | undefined };
}
