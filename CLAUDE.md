# AureonX

AureonX is a multi-asset trading platform that runs on virtual funds. Users trade with a virtual balance that an admin credits, and no real money moves through the app. Never use reference-exchange names, logos, watermarks or copy anywhere.

This file is the single source of truth. It describes **what has shipped**, and nothing planned. Update it in the same change that ships something.

@AGENTS.md

## Shipped state (slice 1: auth, profile, Security Center; slice 2: wallets, transfer, Bills, admin, app shell; slice 3: market data, Home market table, Market tab; slice 4: server price feed, Spot market orders and the Spot terminal; slice 5: Options database, settlement and the Options screen)

- Next.js 16.4.3, App Router, `src/` dir, TypeScript strict, Tailwind v4 through the Turbopack loader (`@tailwindcss/turbopack`), React 19.3.
- Built for Cloudflare Workers with `@opennextjs/cloudflare` 1.20.13 and wrangler 4.152.0:
  - `wrangler.jsonc` sets `nodejs_compat` and `global_fetch_strictly_public`, with compatibility date 2026-10-15.
  - `wrangler.jsonc` turns on Workers Logs, invocation logs and traces, with `redact_query_string: true` so auth tokens in query strings are never logged.
  - Deploying with Workers Builds (settings, build vs runtime variables, Supabase redirect URLs, post-deploy checks, log checks): `docs/deploy.md`. Not deployed yet.
  - `open-next.config.ts` uses the read-only static-assets incremental cache, so no R2/KV/D1/Queue bindings are needed.
  - `public/_headers` makes `/_next/static/*` immutable.
- `globals.css` maps `--font-sans` to `--font-geist-sans` (the `shadcn init` value pointed at itself, so text fell back to a serif font).
- `next.config.ts` sets `images.unoptimized: true`. `cacheComponents` and `partialPrefetching` are **off**, so a page with no request data is plain SSG.
- Supabase helpers in `src/lib/supabase/`:
  - `client.ts`: browser client.
  - `server.ts`: cookie-bound server client, `server-only`.
  - `service.ts`: secret-key client, `server-only`, never imported by client code.
- Pages (all static prerenders; user data loads in client components):
  - `(landing)` group (slice 9): `/` is the public landing page, with no tab bar and no top bar, and the default not-found. Layout: nav (mark, wordmark, Log in, Create account), a live price strip (BTC, ETH, SOL from the shared market store, `--` while loading, missing or delayed), hero, three feature cards, "How virtual balances work", footer (Markets links to `/spot`, `/options`, `/assets`; one disclosure line). Copy is in `messages/en.json` under `Landing`. The brand mark and wordmark are inlined SVG components in `src/components/brand/`. The page is static and never varies by user.
  - `NEXT_PUBLIC_SITE_URL` (optional build variable, set in the Workers Builds variables for production, `docs/deploy.md`): the root layout sets `metadataBase` from it only when it is set and a valid URL, so Open Graph image URLs are absolute. Otherwise `metadataBase` stays unset.
  - The app Home is `/home` (inside `(app)/(with-top-bar)`). The PWA manifest `start_url` is `/home`; the tab bar Home, sign-up, password update and `/auth/*` default targets all go to `/home`. The auth layout logo links to `/` (the landing page).
  - `(app)` shell (slice 2): the `(app)` layout has the session guard and a fixed bottom tab bar; the top bar (avatar, VIRTUAL pill, search, globe, bell, support) comes from the `(app)/(with-top-bar)` group layout, so trading screens placed directly in `(app)` skip it. Bottom tab bar (Home, Market, raised Trade with a label, Options, Assets). Dark theme for the whole app. Brand green is `primary` (`text-primary`, `border-primary`, `accent-primary`): active tab, Home quick-action icons, active tab underlines and links. The old `--accent-green` token was retired by the brand palette; slice 4 moved the market table's leftover `accent-green` classes (which had rendered with no color) to `primary`. Up/down use the `up` / `down` tokens (`emerald-500` / `red-500` in the market table). Screen tags and assumptions: `docs/ui-map.md` §4.10.
  - `(app)/(with-top-bar)` pages (slice 2): `/home` Home (total with hide-eye, quick actions; 6 tiles "Soon"; the market table from slice 3 below them), `/assets`, `/assets/transfer`, `/assets/bills`, `/admin`, `/market` (slice 3, below), and "Coming soon" at `/support`, `/notifications`.
  - `(app)/spot` (slice 4, no top bar; its own header with the market picker and the VIRTUAL pill): the Spot terminal at `/spot?symbol=BTC-USDT`. Without `?symbol` it opens the last viewed market (`aureonx.lastMarket`); the Trade tab and the Home Spot tile link to `/spot` (O24). Chart, order form, then Book / Trades / Orders tabs. Details below under Market data and Supabase; tags and assumptions: `docs/ui-map.md` §4.12.
  - `(app)/options` (slice 5 Part B, no top bar, like Spot): header (symbol sheet of `options_enabled` markets, info sheet of periods and fee, chart toggle remembered in `localStorage` `aureonx.optionsChart`), the shared chart with a dashed entry-price line per open position on the market, the ticket (display mid, Rise/Fall, period slider, premium chips and input, fee and Est. return, Call/Put calling `open_option`), then Positions (countdowns) and Fill. Code: `src/components/options/`, `src/lib/options.ts` (periods and positions under RLS with `::text`, Realtime with random channel suffixes), `src/lib/options-math.ts`, `src/lib/server-clock.ts` (offset from `server_time()` on mount and on visibility, one shared 1 s ticker through `useSyncExternalStore`). It heartbeats the price feed like Spot. Assumptions: `docs/ui-map.md` §4.8.
  - `PriceChart` (`src/components/spot/price-chart.tsx`) is shared: optional `height` (Tailwind classes, Spot's default) and `priceLines`; its strings are in the `Chart` namespace.
  - `SupportFab` (`src/components/app/support-fab.tsx`) on Options and Spot: fixed above the tab bar, hidden while a `data-fab-avoid` element is under it.
  - Money in the UI: amounts are labelled USD. `src/lib/money.ts` (BigInt cents, `::text` selects), `src/lib/wallets.ts` (`useWallets`, Realtime on `wallets`), `src/lib/attempt-key.ts` (one idempotency key per confirm attempt).
  - `(auth)`: `/sign-in`, `/sign-in/mfa` (TOTP step-up to AAL2), `/sign-up`, `/forgot-password`, `/update-password`. The layout exports `dynamic = "error"`.
  - `(app)`: `/account` (UID, email, KYC status read only; nickname, phone and country edited through `update_profile`) and `/account/security` (email verification status, TOTP enroll/verify/remove, password change; passkeys and phone show "Not available yet"). The layout exports `dynamic = "error"`, shows the VIRTUAL pill in the top bar, and runs a client guard that sends AAL1 sessions with a verified factor to `/sign-in/mfa`.
  - Route handlers: `/auth/confirm` (`verifyOtp` with `token_hash`) and `/auth/callback` (PKCE `exchangeCodeForSession`). Both redirect only to same-origin paths (`src/lib/safe-next.ts`); the default target after sign-in is `/home`.
- Market data (slice 3), display only, no money path reads it. Details and weight arithmetic: `docs/market-data.md` §10; decisions O13, O14, O20, O22, O23, O24: `docs/decisions.md` Part 1c.
  - `src/lib/market/`: `types.ts` (normalized `Ticker`, `Market`), `decimal.ts` (BigInt string math for prices), `vision.ts` and `kucoin.ts` (normalizers), `http.ts` (`getJson`, a plain GET with only a signal), `store.ts` (store factory), `use-market-data.ts` (one store per tab through `useSyncExternalStore`), `favorites.ts`, `last-symbol.ts` (`localStorage` key `aureonx.lastMarket`, in try/catch), `md-server.ts` (server only).
  - The browser store polls Vision `ticker/24hr?symbols=` every 5 s (one request for all markets, 4 s timeout, no headers). On failure it asks `/md/v1/tickers` in the same poll and skips Vision for 30 s plus jitter. It pauses while the tab is hidden and refreshes on return. Tickers older than 60 s show "Delayed". Sentry only gets a report when every provider fails (once per streak) and the Vision HTTP 400 message.
  - `GET /md/v1/tickers` (route handler in the app Worker, forced dynamic, outside the proxy matcher): fetches KuCoin `allTickers`, returns only enabled markets (publishable key, RLS), at most 2 retries with jitter. In-memory caches (`stale-cache.ts`): tickers 5 s, failure 10 s, markets list 60 s. While KuCoin fails it answers 200 with `stale: true` and the old tickers (original `ts`, so the client marks them delayed) for up to 60 s after the last good fetch, then 502; the 10 s window keeps KuCoin from being called while it fails. Every failed refresh logs a JSON line and goes to Sentry with the upstream status and retry count. The Cache API does not work on workers.dev; move to it when a custom domain is attached. When `/md/v1` errors the client store keeps the last good tickers on screen and they turn delayed.
  - Keep **at most 20 enabled `markets` rows**: Vision `ticker/24hr` costs weight 2 for 1 to 20 symbols and 40 above that. One invalid symbol fails the whole Vision request (the store then falls back).
  - Screens: the Home market table (`MarketTable` variant `home`, first 8 rows and a link) and `/market` (variant `market`: search field, star toggles, `?q=` from the top bar search). Tabs Optional, Popular, Gainer, Down. The type dropdown has Spot enabled; Options, Forex and Perpetual show Soon. Sell is the best bid, Buy the best ask. Coin icons are initials badges. A row tap saves the last viewed symbol and does not navigate. Tags and assumptions: `docs/ui-map.md` §4.11.
  - Slice 4 terminal data (display only; details `docs/market-data.md` §11). Every exchange call is `getJson` (a plain GET with only a signal, no headers):
    - `klines.ts`: Vision klines (limit 300) with the `GET /md/v1/klines?symbol=&interval=` fallback (KuCoin candles through the Worker, same caches and stale rules as `/md/v1/tickers`, only enabled markets and the 8 intervals). The chart refetches just after each candle closes (at least once a minute) and patches the open candle from the ticker store between refetches. Timeframes 1m, 5m, 15m, 30m, 1h, 4h, More (1D, 1W).
    - `book.ts`: Vision `depth` (20 levels, weight 5) and `aggTrades` (30, weight 4) for the selected symbol only, every 5 s, only while that tab is open and the page visible. No fallback: Vision failing shows "unavailable". The note under them says orders do not enter this book.
    - `Ticker` carries 24 h `high` and `low` (strings) from both normalizers and `/md/v1/tickers`; the terminal shows them with the quote volume under the header.
    - `poller.ts` (framework-free, unit-tested) and `use-poll.ts`: one repeating load that pauses while the page is hidden and reloads at once when shown.
    - Lightweight Charts 5.2.1 (Apache-2.0), loaded on demand by the chart only; its attribution logo stays on (O15).
  - **Owner check in DevTools (Network):** no `OPTIONS` request goes to `data-api.binance.vision`. Trace headers are attached only to same-origin requests while `tracePropagationTargets` is unset (verified in `@sentry/browser` 11.9.0). If an `OPTIONS` request ever appears, the fix is `tracePropagationTargets: []` in `src/instrumentation-client.ts`.
- `src/proxy.ts`: matcher covers `/` (slice 9), `/home`, `/account/*`, `/assets/*`, `/admin/*`, `/market`, `/spot`, `/options`, `/support`, `/notifications` (later slices add their paths). It does not check the admin role; RLS and the RPCs do. It verifies the session with `getClaims()` (ES256, cached JWKS), refreshes cookies, logs errors and fails closed to `/sign-in?next=`. For `/` the proxy only redirects: a request with no `sb-*-auth-token` cookie passes straight through, a valid token (same local `getClaims()` check, no network call) gets a `/home` redirect with `Cache-Control: private, no-store`, and a bad token or an error falls through to the landing page, never to sign-in. Smoke-tested on workerd with `pnpm preview` (C15): `proxy.ts` works, no `middleware.ts` fallback needed.
- Supabase (project on the Free plan), applied through the Management API and recorded in migration history:
  - `supabase/migrations/20261025190257_auth_profiles.sql`: `profiles`, `user_roles`, `wallets`, `ledger`; `private.is_admin`, `private.lock_wallets`, `private.wallet_apply`, the balance-write guard trigger; the signup trigger (profile + random 8-digit UID + 4 wallets at 0, no starting credit); the email-mirror trigger; `public.update_profile`; `public.custom_access_token_hook` (top-level `user_role` claim, `'admin'` or `'user'`). RLS on all four tables, SELECT-only grants, `wallets` and `profiles` in the Realtime publication.
  - Dashboard-only settings (the Management API token has no `auth_config_write`): the Custom Access Token hook is enabled there. Custom email templates need custom SMTP, which is not set up, so emails still use the default `{{ .ConfirmationURL }}` links.
  - `supabase/migrations/20261025233700_wallets_transfer_admin.sql` (slice 2, money only; no UI yet):
    - `public.transfer_between_wallets(from, to, amount_cents, client_request_id)`: both legs go through `wallet_apply` in one transaction (two Bills rows), idempotent on `client_request_id`.
    - `public.admin_adjust_balance(user_id, account, delta_cents, reason, client_request_id)`: checks the `user_role` claim, `aal2` and the live `user_roles` row; writes an `admin_audit_log` row and one Bills row. The reason stays in the audit log.
    - `private.is_admin()` requires `aal2`, so admin RLS reads need a second factor too.
    - `ledger.counter_account` is set on transfer legs. The UI renders Bills text from `en.json`; the DB stores no display copy.
    - `transfers` and `admin_audit_log`: RLS on, no policies, no grants.
    - Tests: `supabase/tests/slice2_part_a.sh` (needs a write-capable Management API token).
  - `supabase/migrations/20261025234445_admin_adjust_description.sql` (slice 2): admin adjustments write the Bills text "Balance adjustment" (`ledger.memo`); the reason stays in the audit log. Slice 2 therefore has two migrations.
  - First admin: the owner's account, added with the owner-approved `insert into public.user_roles` (2026-10-26). Admin actions also need a TOTP factor and an aal2 session.
  - `supabase/migrations/20261026120000_markets_favorites.sql` (slice 3): `markets` (id, base, quote, `display_symbol`, `vision_symbol`, `kucoin_symbol`, `price_decimals`, `sort_order`, `enabled`) and `user_favorites`. RLS on both: anyone reads enabled `markets` rows and nobody writes from the browser; users select, insert and delete only their own favorites (a favorite for an unknown market fails on the foreign key). Seeded with 20 USDT pairs (BTC, ETH, ZEC, SOL, XRP, NEAR, BNB, ENA, WLD, SUI, PEPE, UNI, DOGE, TRX, QNT, HYPE, LINK, TAO, ADA, AAVE). Tested as real roles with temporary users, deleted afterwards.
  - `supabase/migrations/20261026130512_spot_market_orders.sql` (slice 4 Part A, money and price feed; no UI yet). Details, rounding rule and the Part C design: `docs/data-model.md` §16; decisions: `docs/decisions.md` Part 1d.
    - `markets` gains `qty_decimals` and `min_notional_cents` (Vision `exchangeInfo`). `spot_config` (one row): `fee_bps = 10` (0.1%, an assumption) and `max_price_age_s = 60`.
    - `price_snapshots` (bid, ask, `fetched_at`, source; authenticated read), `system_state` (demand window; not readable), `spot_holdings` and `orders` (own rows only, no client writes; guard trigger on holdings).
    - `public.spot_market_order(market_id, side, qty text, client_request_id)`: **no price argument**; buys at the snapshot ask, sells at the bid, refuses a snapshot older than 60 s, checks `qty_decimals` and the minimum order value, rounds cents against the user, idempotent on the key. Bills rows "Bought 0.001 BTC at 50,000.10" / "Sold …" plus a separate "Trading fee".
    - `public.request_price_feed()` (heartbeat, 5 min window). `public.ingest_prices(jsonb)` (`service_role` only).
    - Extensions `pg_cron` and `pg_net`. pg_cron `aureonx-price-tick` every 10 s calls `private.price_tick()`, which posts to the `price-ingest` Edge Function only while the demand window is open; `aureonx-cron-history-cleanup` daily.
    - Edge Function `price-ingest` (`supabase/functions/price-ingest/index.ts`, single file; `supabase/functions/deno.d.ts` types the Deno globals for `pnpm typecheck`). Deployed through the Management API with `verify_jwt: false`; it checks the `x-aureonx-cron-secret` header. The owner set `PRICE_INGEST_SECRET` and the two Vault entries (2026-10-26, `docs/deploy.md` §7); verified end to end: every tick 200, all 20 markets from Vision, snapshots about 5 s old.
    - **Feed cost:** a feed kept running nonstop at 10 s is about 259,000 Edge Function invocations a month against the Free plan's 500,000. **Any signed-in user can keep the feed alive**: a visible trading screen calls `request_price_feed()` every minute, and each call keeps it running for 5 more minutes.
    - The Spot terminal heartbeats `request_price_feed()` once on show and every 60 s, only while the screen is mounted and the tab visible; it stops on hide (`usePriceFeedDemand` in `src/lib/spot.ts`).
    - Tests: `supabase/tests/slice4_part_a.sh`.
  - `supabase/migrations/20261026165953_ingest_prices_ignored_count.sql` (slice 4 fix): replaces `ingest_prices` only. A valid price the forward-only upsert did not write (not newer than the stored snapshot) is reported as `ignored`, not `accepted`. Slice 4 therefore has two migrations.
  - `supabase/migrations/20261026182324_options_settlement.sql` (slice 5 Part A; no UI yet except the Bills label "Option refund"). Rules: `docs/decisions.md` Part 1e.
    - `markets.options_enabled` (true for BTC, ETH, SOL). `option_periods` (30/60/90/120/300 s; `profit_rate_bps`, `fee_bps` 10, `min_premium_cents` 4900, `enabled`; only 30 s enabled, at 600 bps). Authenticated read, writes only through `admin_set_option_period` (claim, aal2, `is_admin()`, audit row).
    - `options_positions`: own rows only, no client writes; CHECKs tie status to the settle fields and the payout to the result. In the Realtime publication with `option_periods`.
    - `public.open_option(market_id, direction, duration_s, premium_cents, client_request_id) → uuid`: **no price argument**. Locks the Options wallet, idempotent on the key (`IDEMPOTENCY_CONFLICT` on changed parameters), entry = snapshot mid at most 15 s old, fee `ceil(premium × fee_bps / 10000)` on top. Bills rows `option_premium` (PnL 0) and `fee` (PnL −fee, as Spot sell fees). Errors: `MARKET_DISABLED`, `PERIOD_NOT_FOUND`, `PERIOD_DISABLED`, `BELOW_MIN_PREMIUM` (DETAIL `min_cents=N`), `PRICE_STALE`, `INSUFFICIENT_FUNDS`.
    - Settlement: `ingest_prices` (returns `settled` and `settle_errors` too) calls `private.settle_options` for each options-market snapshot it wrote, in the same transaction, each market in its own subtransaction: an error is a `RAISE WARNING` (market id and message) counted in `settle_errors`, and the snapshot upserts still commit. Win `option_settle` premium + `floor(premium × rate / 10000)`, PnL +profit; loss `option_settle` 0 cash, PnL −premium; draw `option_refund` premium, PnL 0.
    - `private.void_stale_options()` via pg_cron `aureonx-options-void` every 10 s: positions open past `expires_at + 90 s` become `void`, one `option_refund` row for premium + fee with PnL +fee.
    - Per closed position, Σ ledger PnL = payout − premium − fee (a void nets 0, a draw −fee).
    - Locks: position rows `FOR UPDATE SKIP LOCKED` (batch 500), then wallets ascending; only the guarded transition's winner pays.
    - `private.price_tick` also fires while any options position is open. `public.server_time()` for the countdown offset.
    - `supabase/migrations/20261026183757_options_followups.sql` replaces `open_option`, `void_stale_options` and `ingest_prices` for the settlement isolation and fee PnL above.
    - Tests: `supabase/tests/slice5_part_a.sh [steps]` always runs setup, the steps, then cleanup in one process. It pauses the price tick and the void job during the run; a trap on EXIT, INT, TERM and ERR runs cleanup, which turns them back on and deletes the test users.
  - No runtime code uses the secret key. `src/lib/supabase/service.ts` exists but nothing imports it.
- shadcn/ui initialized: Radix base, `radix-nova` style, `components.json`. Components: `badge`, `button`, `input`, `label`, `slider`. Add more with `pnpm dlx shadcn@4.22.1 add <name>`.
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
  - Also not installed: Motion.

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
| `pnpm test` | `node:test` unit tests (`src/**/*.test.mjs`, `supabase/functions/**/*.test.mjs`): normalizers, decimal math, ranking, the store fallback, the stale cache, the `price-ingest` function, kline/depth/trade normalizers, the poller, the Spot estimate math, the Options ticket math, the cn guard. Needs Node 22.18 or newer (built-in TypeScript stripping) |
| `pnpm lint` | ESLint (`eslint-config-next`) |
| `pnpm build` | `next build` |
| `pnpm build:worker` | OpenNext Cloudflare build into `.open-next/` |
| `pnpm preview` | OpenNext build + local workerd preview |
| `pnpm deploy` | OpenNext build + deploy. **Only with explicit owner sign-off.** |

Gate before any commit: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm build:worker`.

Measure the Worker size with `pnpm exec wrangler deploy --dry-run --outdir <tmp>` and read the `gzip:` figure. The limit is 10 MiB. After slice 9 it is 3,859 KiB (the landing page and brand components, +99 KiB). After slice 5 Part B it was 3,759 KiB (the Options page's server bundle and messages, +41 KiB). After slice 5 Part A it was 3,718 KiB (database only, no change). After slice 4 it was 3,718 KiB (the `/md/v1/klines` route and the terminal; Lightweight Charts is a browser-only chunk). After the slice 3 follow-up it was 3,606 KiB (3,600 KiB on `main` with the brand assets; 3,534 KiB at the end of slice 3 before them; 3,584 KiB after slice 2, 3,582 KiB after slice 1, 2,061 KiB after slice 0). Server code must import Sentry from `@sentry/nextjs/cloudflare`, as `worker.ts` does: importing the full `@sentry/nextjs` in a route handler added 362 KiB. `wrangler check startup` after the follow-up: 51 to 53 ms active CPU locally (43.4 ms after slice 2). After slice 4: 60.5 to 68.8 ms, while `main` measured 70.9 to 99.9 ms on the same machine the same hour, so the sandbox CPU varies more than the slice changes it. Sentry accounts for about 1.2 MiB of the slice 0 figure: about 1.1 MiB for the server SDK and 123 KiB for the `withSentry` wrapper. Slice 1's proxy adds a separate Node middleware bundle, which carries its own copy of the Sentry server SDK chunk (about 1.3 MB raw).

## Hard rules (non-negotiable)

1. **Money:** integer minor units (`bigint` cents), never floats. Asset quantities and prices are Postgres `numeric`, and **strings** in TypeScript. PostgREST returns `numeric` as JSON numbers, so select them with `::text`.
2. **Every balance mutation** goes through an atomic Postgres RPC with row locks. No client or server code updates balance columns directly.
3. **Options expiry is server-authoritative:** `created_at + duration`, computed in the DB.
   - Entry is the snapshot mid, refused (`PRICE_STALE`) unless the snapshot is at most 15 s old and not in the future.
   - Settlement is idempotent through a guarded status transition (`… where status = 'open'`).
   - It settles only at the first snapshot with `expires_at <= fetched_at <= expires_at + 60 s`. A position still open after `expires_at + 90 s` is void: premium and fee refunded, by the SQL-only void job.
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
- Wording: funds are **virtual funds** / a **virtual balance**. Never describe the funds or the platform as a trial or imitation version anywhere: files, UI copy, comments, docs and commit messages. The banned words are simulated, demo and practice, plus the others listed in the Phase 2 brief. This line is the only place they may appear.
- User-facing strings go in `messages/en.json`, never hard-coded.
- Mobile first: build every screen at 390 px first; `md:` and `xl:` add the tablet and desktop layouts.
- Every scrollable page reserves bottom padding equal to the tab bar height plus the safe-area inset (`env(safe-area-inset-bottom)`).

## Working rules

- PR bodies are a one to three sentence summary of what was done, with no other text.
- Docs only record what a future agent needs to read. Do not write docs for the owner.
- After any `shadcn add`, revert the `cn` package from `package.json` and the lockfile and point the component's import at `@/lib/utils`; the cn guard test (`src/lib/cn-guard.test.mjs`) enforces this.
