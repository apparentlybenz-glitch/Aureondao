# AureonX

AureonX is a multi-asset trading platform that runs on virtual funds. Users practice with a virtual balance that an admin credits, and no real money moves through the app. Never use reference-exchange names, logos, watermarks or copy anywhere.

This file is the single source of truth. It describes **what has shipped**, and nothing planned. Update it in the same change that ships something.

@AGENTS.md

## Shipped state (slice 1: auth, profile, Security Center)

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
- Pages (all static prerenders; user data loads in client components):
  - `/` (placeholder) and the default not-found.
  - `(auth)`: `/sign-in`, `/sign-in/mfa` (TOTP step-up to AAL2), `/sign-up`, `/forgot-password`, `/update-password`. The layout exports `dynamic = "error"`.
  - `(app)`: `/account` (UID, email, KYC status read only; nickname, phone and country edited through `update_profile`) and `/account/security` (email verification status, TOTP enroll/verify/remove, password change; passkeys and phone show "Not available yet"). The layout exports `dynamic = "error"`, shows the "VIRTUAL FUNDS" badge, and runs a client guard that sends AAL1 sessions with a verified factor to `/sign-in/mfa`.
  - Route handlers: `/auth/confirm` (`verifyOtp` with `token_hash`) and `/auth/callback` (PKCE `exchangeCodeForSession`). Both redirect only to same-origin paths (`src/lib/safe-next.ts`).
- `src/proxy.ts`: matcher is `/account/:path*` only (later slices add their paths). It verifies the session with `getClaims()` (ES256, cached JWKS), refreshes cookies, logs errors and fails closed to `/sign-in?next=`. Smoke-tested on workerd with `pnpm preview` (C15): `proxy.ts` works, no `middleware.ts` fallback needed.
- Supabase (project on the Free plan), applied through the Management API and recorded in migration history:
  - `supabase/migrations/20261025190257_auth_profiles.sql`: `profiles`, `user_roles`, `wallets`, `ledger`; `private.is_admin`, `private.lock_wallets`, `private.wallet_apply`, the balance-write guard trigger; the signup trigger (profile + random 8-digit UID + 4 wallets at 0, no starting credit); the email-mirror trigger; `public.update_profile`; `public.custom_access_token_hook` (top-level `user_role` claim, `'admin'` or `'user'`). RLS on all four tables, SELECT-only grants, `wallets` and `profiles` in the Realtime publication.
  - Dashboard-only settings (the Management API token has no `auth_config_write`): the Custom Access Token hook is enabled there. Custom email templates need custom SMTP, which is not set up, so emails still use the default `{{ .ConfirmationURL }}` links.
  - No runtime code uses the secret key. `src/lib/supabase/service.ts` exists but nothing imports it.
- shadcn/ui initialized: Radix base, `radix-nova` style, `components.json`. Only `src/components/ui/button.tsx` exists. Add more with `pnpm dlx shadcn@4.22.1 add <name>`.
  - `cn()` in `src/lib/utils.ts` is `twMerge(clsx(...))`. The npm package `cn` was **removed** after a provenance check (the name had a previous unrelated owner). `shadcn add` may rewrite imports to `"cn"`: check every diff and point them back at `@/lib/utils`.
  - `shadcn` is a devDependency only (for the `shadcn/tailwind.css` import).
- next-intl 4.14, English only, no locale segment in URLs:
  - `src/i18n/request.ts` hard-codes `en`.
  - Strings live in `messages/en.json`, and `src/i18n/messages.d.ts` types the keys.
  - The plugin is wired in `next.config.ts`.
  - Public pages stay static.
- Sentry (`@sentry/nextjs` 11.9), errors only (no tracing), every data-collection category off (`src/lib/sentry-options.ts`):
  - Browser: `src/instrumentation-client.ts`.
  - Server errors: `src/instrumentation.ts` (`onRequestError`). `sentry.server.config.ts` runs under `next dev`.
  - Workers: `wrangler.jsonc` `main` is `worker.ts`, which wraps the OpenNext handler with `withSentry`. `open-next-worker.d.ts` types the generated module.
  - Root errors: `src/app/global-error.tsx`.
  - Without a DSN the SDK stays off. No `tunnelRoute`.
  - **Sentry does not capture errors inside `proxy.ts` on Workers:** OpenNext stubs the instrumentation loader in the Node middleware bundle. Handle and log errors there explicitly.
- Not shipped yet:
  - `supabase/migrations/20261025000000_initial_schema.sql` is a **proposal, not applied**. Each slice cuts its own migration from it.
  - Also not installed: Lightweight Charts, Motion.

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

Measure the Worker size with `pnpm exec wrangler deploy --dry-run --outdir <tmp>` and read the `gzip:` figure. The limit is 10 MiB. After slice 1 it is 3,582 KiB (2,061 KiB after slice 0). Sentry accounts for about 1.2 MiB of the slice 0 figure: about 1.1 MiB for the server SDK and 123 KiB for the `withSentry` wrapper. Slice 1's proxy adds a separate Node middleware bundle, which carries its own copy of the Sentry server SDK chunk (about 1.3 MB raw).

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
- Wording: funds are **virtual funds** / a **virtual balance**. Never describe the funds or the platform as a trial or imitation version anywhere: files, UI copy, comments, docs and commit messages. The banned words are listed in the Phase 2 brief.
- User-facing strings go in `messages/en.json`, never hard-coded.
- Mobile first: build every screen at 390 px first; `md:` and `xl:` add the tablet and desktop layouts.
- Every scrollable page reserves bottom padding equal to the tab bar height plus the safe-area inset (`env(safe-area-inset-bottom)`).
