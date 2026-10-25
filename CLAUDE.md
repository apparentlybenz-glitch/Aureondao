# AureonX

AureonX is a multi-asset trading platform that runs on virtual funds. Users practice with a virtual balance that an admin credits, and no real money moves through the app. Never use reference-exchange names, logos, watermarks or copy anywhere.

This file is the single source of truth. It describes **what has shipped**, and nothing planned. Update it in the same change that ships something.

@AGENTS.md

## Shipped state (Phase 1: bare scaffold)

- Next.js 16.4.3, App Router, `src/` dir, TypeScript strict, Tailwind v4 through the Turbopack loader (`@tailwindcss/turbopack`), React 19.3.
- Built for Cloudflare Workers with `@opennextjs/cloudflare` 1.20.13 and wrangler 4.152.0:
  - `wrangler.jsonc` sets `nodejs_compat` and `global_fetch_strictly_public`, with compatibility date 2026-10-15.
  - `open-next.config.ts` uses the read-only static-assets incremental cache, so no R2/KV/D1/Queue bindings are needed.
  - `public/_headers` makes `/_next/static/*` immutable.
- `next.config.ts` sets `images.unoptimized: true`. `cacheComponents` and `partialPrefetching` are **off**, so a page with no request data is plain SSG.
- Supabase helpers in `src/lib/supabase/`:
  - `client.ts`: browser client.
  - `server.ts`: cookie-bound server client, `server-only`.
  - `service.ts`: secret-key client, `server-only`, never imported by client code.
- Pages: `/` (static placeholder) and the default not-found. No features exist yet.
- shadcn/ui initialized: Radix base, `radix-nova` style, `components.json`. `cn()` comes from the `cn` package (shadcn's replacement for clsx + tailwind-merge), re-exported by `src/lib/utils.ts`. Only `src/components/ui/button.tsx` exists. Add more with `pnpm dlx shadcn@latest add <name>`.
- Not shipped yet:
  - Supabase migrations: `supabase/migrations/*` is a **proposal, not applied**.
  - Also not installed: next-intl, Sentry, Lightweight Charts, Motion.

Planning docs are **proposals, not shipped behavior**:
- `docs/decisions.md`: resolved conflicts and open decisions. Wins over the other docs.
- `docs/data-model.md`
- `docs/market-data.md`
- `docs/ui-map.md`
- `docs/build-order.md`

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Next dev server (Node) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | ESLint (`eslint-config-next`) |
| `pnpm build` | `next build` |
| `pnpm build:worker` | OpenNext Cloudflare build into `.open-next/` |
| `pnpm preview` | OpenNext build + local workerd preview |
| `pnpm deploy` | OpenNext build + deploy. **Only with explicit owner sign-off.** |

Gate before any commit: `pnpm typecheck && pnpm lint && pnpm build && pnpm build:worker`.

Measure the Worker size with `pnpm exec wrangler deploy --dry-run --outdir <tmp>` and read the `gzip:` figure. The limit is 10 MiB. At this scaffold it is 839 KiB.

## Hard rules (non-negotiable)

1. **Money:** integer minor units (`bigint` cents), never floats. Asset quantities and prices are Postgres `numeric`, and **strings** in TypeScript. PostgREST returns `numeric` as JSON numbers, so select them with `::text`.
2. **Every balance mutation** goes through an atomic Postgres RPC with row locks. No client or server code updates balance columns directly.
3. **Options expiry is server-authoritative:** `created_at + duration`, computed in the DB.
   - Settlement is idempotent through a guarded status transition (`… where status = 'open'`).
   - It skips any missing, invalid or >60 s old price.
   - It never falls back to a random or synthetic price.
4. **Money paths never take a client-supplied price.** Prices are fetched server-side.
5. **Market data:** poll REST snapshots, not websocket proxies. One shared store per browser; terminal tabs never make their own upstream calls.
6. **Upstream calls:** bounded retry with jittered backoff plus a short negative cache. Never hammer a rate-limited upstream.
7. **Realtime channel names** get a `crypto.randomUUID()` suffix per mount.
8. **RLS is on for every table.** The Supabase secret / service-role key is used only in server code, Edge Functions and cron.
9. **No loosening of `tsconfig`, and no `eslint-disable` comments.**
10. **Never export `runtime = 'edge'`.** OpenNext runs the Node.js runtime.

## Compute budget rules

- Browser → Supabase directly for reads (RLS) and RPC writes. Live updates come from Supabase Realtime.
- **Never poll a Next route.** Server actions and route handlers exist only where a secret is needed.
- Display market data comes from public APIs in the browser, or from one shared cached route. Workers Cache hits still bill as requests, with no CPU.
- Options settlement runs inside Supabase (pg_cron + Edge Function). There is no external scheduler.
- The proxy/middleware matcher covers protected routes only, and verifies the JWT locally.
- Public pages are static. Do not use ISR or `revalidate`.

## Conventions

- Market ids look like `BTC-USDT`. Display them as `BTC/USDT`.
- Git author for every commit: `apparentlybenz-glitch <apparentlybenz@gmail.com>`.
- `AGENTS.md` is written by `next dev`. Keep it committed.
