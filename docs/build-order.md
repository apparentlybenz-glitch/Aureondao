# AureonX: build order (vertical slices)

## Schedule (6-day core, set at Phase 2 start)

| Day | Work |
|---|---|
| 1 | Slice 0 (foundation), slice 1 (auth) |
| 2 | Slice 2 (wallets, assets, transfer, bills) and the mobile app shell |
| 3 | Slice 3 (market data) with the Home market table, then start slice 4 (Spot) |
| 4 | Finish slice 4 |
| 5 | Slice 5 (Options and settlement), built to the owner's Options reference screen |
| 6 | Slice 9 (homepage), then a full bug pass |

**Deferred until after day 6:** slice 6 (Forex), Perpetual (O21), slice 7 (deposit and withdraw queues), slice 8 (KYC), slice 10 (locales). Their sections stay below, marked deferred.

Mobile first (C20): every UI slice is built at 390 px first and ends with a phone review before sign-off.

Each slice ends at a STOP gate: report, then wait for sign-off before the next slice.

Each slice ships end to end (DB → RPC → UI) and leaves `main` deployable. Slices follow the brief's order. Slice 0 is new: it clears the blockers found in Phase 1.

Rules for every slice:
- **Gate:** `pnpm typecheck && pnpm lint && pnpm build && pnpm build:worker`, then record the gzip Worker size from `pnpm exec wrangler deploy --dry-run --outdir /tmp/wd` (budget: 10 MiB).
- **Migrations:** each slice adds its own migration, cut from the proposed `supabase/migrations/20261025000000_initial_schema.sql` (O18 ★). Apply only that slice's tables (the Free plan, O19, has no Supabase branching, so apply to the project directly), then run Supabase advisors (security + performance): zero errors.
- **Money paths:** add SQL tests for every RPC (happy path, every error code, idempotent replay) and a concurrency test (N parallel calls; `wallet = Σ ledger` afterwards).
- **Docs:** update CLAUDE.md in the same PR, describing what shipped and nothing planned.
- **Open decisions:** a slice that depends on a `docs/decisions.md` item starts only after the owner decides it.

---

## Slice 0: Unblock and foundations
**Scope**
- Allow the hosts the sandbox blocked: `ui.shadcn.com`, the exchange and FX hosts in `docs/market-data.md` §1.2, and `supabase.com`.
- ~~Run `shadcn init`~~ (done in Phase 1 after the host was allowed).
- Wire next-intl with `en` only (no `[locale]` segment).
- Add Sentry (`@sentry/nextjs`: `instrumentation.ts` + `instrumentation-client.ts`, no `tunnelRoute`).
- Create the Supabase project with asymmetric JWT signing keys.
- Re-run the market-data probe script (`docs/market-data.md` §1.4) from a dev machine and from a throwaway diagnostic Worker, and fill in the measurement table.

**Files:** `components.json`, `src/lib/utils.ts`, `src/app/globals.css`, `src/i18n/request.ts`, `messages/en.json`, `next.config.ts`, `instrumentation*.ts`, `.env.example`, `docs/market-data.md`.

**Verify:**
- The gate passes.
- `pnpm preview` serves `/` from workerd.
- A test error reaches Sentry from both browser and server.
- The Worker size delta from Sentry is recorded.

**Done when:**
- The probe table has real status, latency, CORS and rate-limit values.
- O1, O3, O4, O12, O13 and O14 can be decided on measured data.

## Slice 1: Auth, profile and Security Center
**Scope**
- Pages: sign-up, sign-in, reset password, `/auth/callback`, `/auth/confirm`.
- `proxy.ts`: matcher covers protected routes only, verifies with `getClaims()` (local JWT verification).
- Migration 1: `profiles`, `user_roles`, `wallets`, `ledger`, the locked balance-mutation function (`private.wallet_apply`), the signup trigger (profile + UID + 4 wallets at 0; no starting credit, see `docs/decisions.md` Part 1b), and the custom access token hook (`user_role` claim).
- Auth: email confirmation through `verifyOtp({ token_hash, type })`, not PKCE; `emailRedirectTo` on sign-up.
- `/account`: nickname, UID, email, phone, country, KYC status (read only).
- `/account/security`: TOTP enroll/verify, password change, email verification status. Passkeys (O9, deferred) and phone MFA (O8: profile field only) show as unavailable.
- The "VIRTUAL FUNDS" header badge.

**Files:** `src/proxy.ts`, `src/app/(auth)/**`, `src/app/(app)/layout.tsx`, `src/app/(app)/account/**`, `supabase/migrations/*_auth_profiles.sql`.

**Verify:**
- `pnpm preview`: signed-out users get a redirect on protected paths; public paths never run the proxy.
- A warm request makes no Auth network call (check Worker logs).
- Every signup creates exactly 1 profile and 4 wallets.
- A non-admin JWT has `user_role = 'user'`.
- TOTP step-up reaches `aal2`.

**Done when:** a user can sign up, sign in, enroll TOTP and edit their nickname. The proxy is confirmed working on Workers (C15), or swapped for `middleware.ts` (O17).

## Slice 2: Wallets, assets, transfer, bills and admin credit
**Scope**
- `wallet_apply` primitive, `ledger`, `transfers`, `transfer_between_wallets`, `admin_adjust_balance`, `admin_audit_log`, `private.is_admin()`.
- `/assets`: total balance header, the four sub-wallet cards, profit chart (O11), Bills ledger with keyset pagination.
- `/assets/transfer`.
- `/admin` shell, `/admin/users` (list + detail), credit/debit form.
- Realtime on `wallets` (channel suffix `crypto.randomUUID()`).

**Files:** `src/app/(app)/assets/**`, `src/app/admin/**`, `src/lib/money.ts` (string/cents formatting; no floats), `supabase/migrations/*_wallets_ledger.sql`.

**Verify:**
- SQL tests: direct `UPDATE wallets` is rejected even for the service role.
- 20 parallel transfers leave `wallet = Σ ledger`.
- Replaying a `client_request_id` returns the same row.
- Balances render from `::text` selects.

**Done when:** an admin credits virtual funds, the user sees it live, moves it between sub-wallets, and every movement appears in Bills.

## Slice 3: Market data provider and the markets list
**Scope**
- Client `MarketDataProvider`:
  - Leader tab elected with Web Locks; data shared over BroadcastChannel.
  - Provider fallback chain, staleness rules, jittered retry with a 10 s negative cache, and pause when the page is hidden.
- `/md/v1/*` shared cached route, placed per O13.
- `markets` and `price_snapshots` tables.
- `price-ingest` Edge Function + `ingest_prices`, applying the O12 validation, with `pg_cron` at 10 s and demand gating.
- `request_price_feed`, `favorites` / `toggle_favorite`.
- MarketList (filters Favorites/Spot/Forex/Options; sort by symbol, last price, change), and the Assets USD total valued from the store.

**Files:** `src/lib/market-data/**`, `src/components/market/market-list.tsx`, `workers/md/**` (if O13 ★), `supabase/functions/price-ingest/**`, `supabase/migrations/*_markets_prices.sql`.

**Verify:**
- 3 tabs open → one set of upstream calls (DevTools network).
- No browser request to any Next route repeats.
- A killed provider triggers fallback.
- A stale snapshot (>60 s) is visibly flagged.
- `cron.job_run_details` shows a 10 s cadence only while there is demand.
- The Edge Function rejects calls without the secret header.

**Done when:** live tickers render in the markets list. `price_snapshots` stays ≤11 s old while a terminal is open, and stops updating when no terminal is open.

## Slice 4: Spot terminal
**Scope**
- Shared terminal components: Chart (Lightweight Charts v5, AureonX text watermark), OrderBook with a Latest Trades tab, MarketList, PositionsTable.
- Limit/Market tabs, side-by-side Buy and Sell panels, 0–100% slider.
- `spot_holdings`, `orders`, `place_spot_order`, `cancel_order`, `match_open_orders`.
- Open Orders / History tabs.
- Mobile tab layout: Chart / Book / Trades / Order.

**Files:** `src/components/terminal/**`, `src/app/(app)/spot/**`, `supabase/migrations/*_spot.sql`.

**Verify:**
- A market order fills at a server snapshot ≤15 s old, or returns `PRICE_STALE`.
- A resting limit order fills when a later snapshot crosses it.
- Cancel releases held funds.
- Rounding goes against the user (SQL tests).
- Layout checked at 390, 768 and 1280 px.

**Done when:** a user can buy and sell any spot market with virtual funds, and every fill appears in Bills.

## Slice 5: Options terminal plus settlement
**Scope**
- `cycle_config` (admin-set rates, never hard-coded), `options_positions`, `open_option`, `settle_due_options`, `settle_my_expired_options`, `server_time`, `get_options_stats`.
- `/options`:
  - "I expect {SYMBOL} will Rise / Fall".
  - Cycles 30/60/90/120/300 s, premium presets + custom amount.
  - Live fee and expected profit.
  - Slide-to-confirm.
  - Countdown computed from server `expires_at`.
  - Positions / Filled Orders / Statistics tabs.
- `/admin/options-config`.
- Underlyings per O4. Entry, outage and tie rules per O5, O6 and O7.

**Files:** `src/app/(app)/options/**`, `src/components/options/**`, `src/app/admin/options-config/**`, `supabase/migrations/*_options.sql`.

**Verify:**
- 6+ concurrent settlers on 40+ expired positions credit each position exactly once.
- Settlement skips a missing, invalid or >60 s old price, and any price observed before expiry.
- No code path accepts a client price (grep RPC signatures).
- Settle-on-read works with cron paused.

**Done when:** a 30 s option opens, counts down in sync with the server, settles within about 10 s of expiry at a real fetched price, and pays exactly once.

## Slice 6: Forex terminal (deferred until after day 6)
**Scope** (depends on O1, O2 and O3):
- Full chart: timeframes 1m–1M, left drawing toolbar (ported plugin primitives), volume with MA5/MA10/MA20, Native/Depth toggle, AureonX watermark.
- Book/trades panel per O3.
- `forex_positions`, `place_forex_order`, `close_forex_position`.
- Pairs: XAU/USD, EUR/USD, AUD pairs, CAD/JPY.

**Files:** `src/app/(app)/forex/**`, `src/components/chart/drawing/**`, `supabase/migrations/*_forex.sql`.

**Verify:**
- Forex orders return `PRICE_STALE` whenever only daily data exists.
- Indicative data (if O3 b) never reaches an RPC.
- Drawings persist across reloads.

**Done when:** the terminal matches the spec's layout, with every unavailable panel handled as decided.

## Perpetual (deferred until after day 6, O21)
**Scope:** not in v1. Revisit with Forex. It needs funding rates, margin and liquidation, designed as their own money-path slice.

## Slice 7: Deposit and withdraw requests with admin review (deferred until after day 6)
**Scope**
- `payment_networks`, `deposits`, `withdrawals`.
- `request_deposit`, `request_withdrawal` (freezes funds; requires KYC + AAL2), `cancel_withdrawal`, `admin_review_deposit`, `admin_review_withdrawal`.
- Steppers:
  - Deposit: coin → network → virtual-funds notice (O10) → amount.
  - Withdraw: coin → network → address → amount.
- Fiat variants.
- Admin review queues with Realtime.

**Files:** `src/app/(app)/assets/{deposit,withdraw}/**`, `src/app/admin/{deposits,withdrawals}/**`, `supabase/migrations/*_funding.sql`.

**Verify:**
- An approved deposit credits once.
- A rejected withdrawal releases the hold.
- An approved withdrawal debits the hold.
- Double review returns `REQUEST_NOT_PENDING`.
- No real receiving address appears anywhere.

**Done when:** the full request → review → ledger loop works for crypto and fiat.

## Slice 8: KYC (deferred until after day 6)

> Locked: the full multi-step UI is built, but uploaded files are **not stored**. The admin reviews text fields only. No ID photo or selfie is persisted anywhere, so there is no `kyc` bucket.
**Scope**
- `kyc_submissions` (text fields only), `submit_kyc`, `admin_review_kyc`. No storage bucket.
- Steps: country → document type → personal info → document upload + selfie. The upload steps run in the browser only; files are never sent to Storage, a server action or any API.
- Admin queue showing the text fields only.

**Files:** `src/app/(app)/account/kyc/**`, `src/app/admin/kyc/**`, `supabase/migrations/*_kyc.sql`.

**Verify:**
- User A cannot read user B's submission (RLS test).
- No request carrying file bytes leaves the browser during KYC (network tab), and no storage bucket exists.
- Approving sets `profiles.kyc_status` and unlocks withdrawals.

**Done when:** a user submits KYC, an admin approves or rejects it, and the status gates withdrawals.

## Slice 9: Public homepage
**Scope:** Navbar, Hero, Benefits, Security, Features, Live Market Preview (store bulk ticker), CTA, support-widget placeholder, Footer (virtual-funds disclosure, chart attribution per O15), and `/legal/*`. Everything static.

**Files:** `src/app/(marketing)/**`, `src/components/marketing/**`.

**Verify:**
- `next build` marks every marketing route `○ (Static)`.
- No reference-exchange names or assets appear (grep).
- Lighthouse at 390 px.

**Done when:** the homepage ships static, with copy reviewed.

## Slice 10: Additional locales (deferred until after day 6)
**Scope:** add locales to next-intl. First revisit the i18n routing default in `docs/decisions.md` (lower-stakes table): a second locale probably means adding `[locale]` routing, and translate `messages/*.json`.

**Verify:** public pages stay static, and the proxy matcher still covers protected routes only.

**Done when:** every user-facing string comes from messages, and each new locale is complete.
