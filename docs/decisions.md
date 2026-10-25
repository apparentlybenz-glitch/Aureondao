# AureonX: merged decisions (Phase 1)

This file merges the three planning docs (including the market-data re-probe of 2026-10-25, round 2):

- `data-model.md` (DM)
- `market-data.md` (MD)
- `ui-map.md` (UI)

Part 1 lists every conflict found while merging and how it was resolved. Part 2 lists the decisions that still need the owner's call. Where another doc disagrees with this file, this file wins.

Nothing in Part 2 has been implemented. The ★ option is the recommendation, and the proposed migration already follows it where the choice touches the schema.

---

## Part 1: Conflicts resolved at merge

| # | Conflict | Resolution | Why |
|---|---|---|---|
| C1 | Table and RPC names. UI expected `instruments`, `option_cycles`, `option_orders`, `ledger_entries`, `deposit_requests`, `place_option_order`, … DM used `markets`, `cycle_config`, `options_positions`, `ledger`, `deposits`, `open_option`, … | **DM names win.** DM §12 maps each UI name to its replacement. | They follow the brief, and the migration was tested with them. |
| C2 | Wallet shape. UI expected one row per (wallet, asset) holding `numeric`; DM uses one USDT-cents row per sub-wallet plus `spot_holdings` (`numeric` qty) | **DM shape.** | Keeps cash in integer cents (hard constraint 1) and gives a single mutation primitive. |
| C3 | Admin claim. UI's proxy read `app_metadata.role`; DM adds a top-level `user_role` claim through a custom access token hook backed by `user_roles` | **`user_role` claim from the hook.** UI §1.3 updated. | One source of truth (`user_roles`). `private.is_admin()` reads the table, so RLS never trusts a stale token for writes. |
| C4 | Numeric serialization. UI assumed PostgREST returns `numeric` as strings; DM found it returns JSON numbers | **Every select of a numeric or money column casts with `::text`** (`select=qty::text,…`), and TS types those fields as `string`. UI §10 updated. | `JSON.parse` would otherwise turn quantities into floats (hard constraint 1). |
| C5 | Settlement price owner and cadence. MD proposed a `price-oracle` Edge Function every 60 s; DM proposed `price-ingest` every 10 s, demand-gated | **One function, `price-ingest`, every 10 s, demand-gated (DM §7).** MD's validation (median of ≥2 sources, dispersion limit) runs inside it before `ingest_prices`. MD §3.5 and §7 updated. | At 60 s, `open_option`'s 15 s entry-freshness check would fail most of the time. 10 s stays under the free Edge quota (115 k/month gated, 259 k nonstop, against 500 k). |
| C6 | Freshness thresholds. MD: source timestamp ≤30 s, fetch ≤10 s. DM: entry and fills ≤15 s; settlement at or after expiry and ≤60 s | **Both apply, in layers.** The Edge Function drops any source older than 30 s or outside the dispersion limit. The DB then enforces its own checks (≤15 s for entry and fills; at-or-after expiry and ≤60 s for settlement). | Defense in depth. The DB never trusts the function's own judgement of freshness. |
| C7 | Edge caching. The brief and UI §5.5 assumed cached hits never reach the Worker; MD verified that Cache Rules sit behind a Worker, and that **Workers Cache** serves hits without running code but **still bills each hit as a request** | **MD is correct.** UI §5.5 updated. The budget counts every market-data hit as a Worker request (with 0 CPU). | Cloudflare pricing doc: "Cache hits count as requests but do not consume CPU time." |
| C8 | Market-data route path. UI used `/api/market/*` in the app Worker; MD used `/md/v1/*` on a separate Worker | **Path is `/md/v1/*` in all docs.** Which Worker hosts it is open decision O13. | One name everywhere; the host is a real trade-off. |
| C9 | Deposit "address" step. UI had AddressDisplay (platform address + QR); DM stores no address | **No receiving address is ever shown** (DM D1 ★). The step becomes a "Demo: no real funds are received" notice. UI route table updated. The flow is coin → network → notice → amount. | The brief says no real money moves. Showing an address invites people to send real funds to a platform that can't credit them. The withdraw flow keeps its destination-address step: the address is recorded but nothing is sent. |
| C10 | Phone MFA. UI said phone MFA is built in; Supabase billing docs list phone MFA under the paid **Advanced MFA** add-on, unavailable on the Free plan | **Corrected.** Phone MFA is open decision O8. UI security row annotated. | Source: <https://supabase.com/docs/guides/platform/billing-on-supabase> (add-ons list). |
| C11 | Profit chart. UI wanted hourly `portfolio_snapshots` via pg_cron; DM uses realized PnL from `ledger.pnl_cents` | **DM default** (no table, no cron); the choice stays open as O11. | Snapshots need server prices for every held asset every hour, and deposits netted out. |
| C12 | Forex order model. UI D6 wanted spot-like conversion; DM implements percentage-return margin positions, no leverage | **DM default** (the migration implements it); open as O2. | Spot-like FX needs JPY/CAD/XAU balances, which breaks the single-currency-cents model. |
| C13 | Options underlyings. MD says XAU is viable through tokenized gold (PAXG/XAUT); DM seeds forex/metals with `options_enabled = false` | **v1 default: crypto only** (matches the seed); XAU proxy is open as O4. | Every settlement then has ≥2 fresh, independent sources. |
| C14 | Symbol format | **Id `BTC-USDT` (DB, URLs, code); display `BTC/USDT` (UI only).** | Hyphenated ids are URL-safe; both docs already used them. |
| C15 | Proxy file. UI called OpenNext's `proxy.ts` support "experimental"; the OpenNext changelog lists it as a shipped feature (#1309) without that label | **Use `proxy.ts`, and smoke-test it on Workers in slice 1** (`pnpm preview`); fall back to `middleware.ts` if it fails (O17). | Cheap to verify; the fallback is the same code. |
| C16 | KYC gating | **No conflict:** UI D7-A and DM D9 agree (KYC approved + AAL2 if MFA is enrolled, for withdrawals only). Implemented in the proposed migration. | |
| C18 | Market-data fetches vs shared fetch wrappers. The round-2 re-probe found that `data-api.binance.vision` answers every CORS preflight with 403 | **Market-data calls are CORS-simple GETs**: no custom headers, no `Content-Type`, and never routed through a wrapper that adds Supabase `apikey`/auth or tracing headers. Applies to the UI store and Sentry fetch instrumentation (no trace-propagation headers to exchange hosts). | Any custom header would trigger a preflight, which fails. Re-checked by hand on 2026-10-25 from sandbox egress. |
| C19 | Browser provider chain. MD round 1 planned Binance Vision → OKX → Bybit → KuCoin in the browser; round 2 measured from sandbox egress (US-located datacenter IP): KuCoin sends no `Access-Control-Allow-Origin` for our origin, `api.binance.com` returns 451 and Bybit returns 403 | **Browser chain: Vision → OKX → shared `/md/v1` fallback.** KuCoin is server-side only (`price-ingest`, Worker fallback). Bybit and `api.binance.com` are server-side candidates only, until a real browser or deployed Worker shows them reachable. | CORS is the deciding evidence for browser-direct. Sandbox egress does not prove browser or Worker reachability; see `docs/market-data.md` §1.6. |
| C17 | `cacheComponents` / `partialPrefetching` (on by default in the Next 16.4 template) | **Off in the scaffold**; open as O16. | With them off, a page with no request data is plain SSG and maps onto OpenNext's read-only static-assets cache. PPR adds a resume path through the Worker. |

---

## Part 2: Open decisions for sign-off

The ★ option is recommended. Each line gives one good point and one bad point.

### Product scope

**O1. Forex terminal data** (MD D1/D3, DM D2). No free intraday FX/metal source was verified, and every probe was blocked from the sandbox.
- ★ (a) v1 Forex shows daily reference data with trading disabled until an intraday source passes probing. *Good:* honest, free. *Bad:* the terminal is mostly inert.
- (b) Add a free limited source (unofficial chart endpoint, TwelveData free key, or gold-api). *Good:* intraday charts. *Bad:* ToS, caps (TwelveData: 800 calls/day) or unverified freshness.
- (c) Paid FX feed. *Good:* full product. *Bad:* cost and licensing.

**O2. Forex order model** (DM D3 vs UI D6).
- ★ (a) Percentage-return positions, no leverage (in the migration). *Good:* one USDT wallet, losses capped. *Bad:* not realistic FX.
- (b) Spot-like conversion. *Good:* reuses the spot form exactly. *Bad:* multi-currency balances and FX valuation.
- (c) Leveraged margin with SL/TP. *Good:* realistic. *Bad:* liquidation engine; out of v1.

**O3. Forex order book, trades and volume panels** (MD D2). These don't exist publicly for OTC FX.
- ★ (a) Hide the depth and trade panels for FX; show bid/ask/spread. *Good:* nothing fabricated. *Bad:* differs from the spec's layout.
- (b) Synthetic book labelled "Indicative", never used in money paths. *Good:* matches the spec visually. *Bad:* invented data that users may read as real liquidity.
- (c) Price ladder of recent mid ticks. *Good:* real data. *Bad:* sparse with slow sources.

**O4. Options underlyings in v1** (MD D5, DM D2).
- ★ (a) Crypto only. *Good:* ≥2 fresh independent sources for every settlement. *Bad:* the "I expect XAU/USD will…" example is unavailable.
- (b) Crypto + XAU via a tokenized-gold proxy. *Good:* gold available 24/7, and live on 3 venues in the round-2 probe (agreeing within ~2.5 bp). *Bad:* the proxy differs from spot gold (PAXG ran ~25 bp above XAUT), which must be disclosed.
- (c) Daily-fixing FX options. *Good:* honest with free data. *Bad:* breaks the 30–300 s cycle UX.

**O5. Options entry price** (DM D5).
- ★ (a) Latest snapshot ≤15 s old. *Good:* instant and simple. *Bad:* up to about 11 s of look-ahead edge against the live feed.
- (b) Deferred entry: the first snapshot taken after `created_at`. *Good:* no look-ahead. *Bad:* entry appears 1–10 s later, plus a refund path.
- (c) Server action fetches the price with a secret. *Good:* fresh price. *Bad:* a money path in the Worker.

**O6. Settlement after a long price outage** (DM D6).
- ★ (a) Settle at the first valid post-expiry price. *Good:* never stale; no extra code. *Bad:* can settle minutes late.
- (b) Auto-void after expiry + 2 min. *Good:* fair. *Bad:* extra status, ledger kind and RPC.
- (c) Admin voids manually. *Good:* controlled. *Bad:* needs ops attention.

**O7. Tie (settle = entry)** (DM D7).
- ★ (a) Refund the premium, keep the fee. *Good:* standard. *Bad:* the user still pays the fee.
- (b) Count as a loss. *Good:* simplest. *Bad:* feels unfair.
- (c) Full refund. *Good:* friendliest. *Bad:* fee-free retries.

**O8. Phone verification and phone MFA** (C10).
- ★ (a) Phone is a profile field with no MFA factor in v1; TOTP (and passkeys, O9) cover MFA. *Good:* free tier, no SMS cost. *Bad:* the Security Center "phone" item becomes informational only.
- (b) Supabase Pro + Advanced MFA add-on + SMS provider. *Good:* full spec. *Bad:* Pro plan fee, add-on fee and per-SMS cost.
- (c) Verify the phone number once via Supabase phone OTP (SMS provider), not as MFA. *Good:* verified number. *Bad:* per-SMS cost, and still not MFA.

**O9. Passkeys** (UI D4).
- ★ (a) Supabase native passkeys (beta). *Good:* no server code or secrets. *Bad:* experimental API; first-factor sign-in only in the JS SDK.
- (b) `@simplewebauthn/server` in server actions. *Good:* a true second factor. *Bad:* secret-holding auth code and session-minting workarounds.
- (c) Defer. *Good:* smallest scope. *Bad:* the spec item stays unchecked.

**O10. Deposit flow meaning** (DM D1; resolved as C9 unless you choose otherwise).
- ★ (a) No address; a labelled simulated request. *Good:* nobody sends real funds. *Bad:* less realistic.
- (b) Placeholder address marked "DEMO, DO NOT SEND". *Good:* realistic stepper. *Bad:* looks real; someone will send funds.
- (c) A real address. *Bad:* real custody and regulatory exposure, contradicting "no real money". Not recommended.

**O11. Profit chart source** (C11).
- ★ (a) Realized PnL from `ledger.pnl_cents`. *Good:* exact, zero extra writes. *Bad:* no unrealized PnL.
- (b) Hourly `portfolio_snapshots`. *Good:* includes unrealized PnL. *Bad:* new table, cron and server-side valuation of every asset.

### Market data and infrastructure

**O12. Settlement price tolerance** (MD D4).
- ★ (a) Median of ≥2 sources within 50 bp. *Good:* robust. *Bad:* may be UNAVAILABLE during spikes, delaying settlement.
- (b) Median of ≥3, no dispersion check. *Good:* rarely unavailable. *Bad:* needs 3 providers reachable from one region.
- (c) Primary source plus a ±1% sanity check. *Good:* simple. *Bad:* single-source risk.

**O13. Where `/md/v1/*` lives** (MD D7).
- ★ (a) A separate small `aureonx-md` Worker with Workers Cache and a Placement Hint. *Good:* caching never touches app responses or cookies, and static assets stay unbilled. *Bad:* a second deployable.
- (b) Route handlers in the OpenNext Worker. *Good:* one deployable. *Bad:* enabling Workers Cache there bills static-asset requests and risks caching app responses.

**O14. Users in exchange-restricted regions (e.g. US 451s)** (MD D6). From the sandbox's US-located IP, `api.binance.com` returned 451 and Bybit 403, while Vision, OKX and KuCoin answered.
- ★ (a) Add a US-accessible public source to the fallback chain. *Good:* a compliant data path. *Bad:* more adapters to maintain.
- (b) Fallback through an EU-placed Worker. *Good:* works for everyone. *Bad:* possible exchange-ToS concern.
- (c) Geo-gate the app. *Good:* simplest. *Bad:* loses users.

**O15. Chart attribution** (UI D10). Lightweight Charts' Apache-2.0 NOTICE requires crediting TradingView. That is a licence notice, not reference-exchange branding.
- ★ (a) Keep the small attribution logo on charts. *Good:* compliant by default. *Bad:* a third-party mark on the chart.
- (b) Turn the logo off; credit on `/legal` and in the footer. *Good:* clean chart. *Bad:* the credit must stay visible.

**O16. Next 16 `cacheComponents` / `partialPrefetching`** (C17).
- ★ (a) Off (scaffold). *Good:* plain SSG on the static-assets cache. *Bad:* gives up Next 16's instant-navigation model.
- (b) On, with `ensureStatic`. *Good:* the current Next default. *Bad:* PPR resume path through the Worker; more moving parts on OpenNext.

**O17. Proxy file** (UI D2, C15).
- ★ (a) `proxy.ts`, smoke-tested in slice 1. *Good:* not deprecated. *Bad:* newer path in OpenNext; Sentry isn't instrumented there.
- (b) `middleware.ts` (edge). *Good:* long-proven in OpenNext. *Bad:* deprecated in Next 16.

**O18. Migration rollout.**
- ★ (a) Split the proposed migration into per-slice migrations as each slice lands. *Good:* the database only contains shipped features, which keeps CLAUDE.md honest. *Bad:* some re-cutting work.
- (b) Apply the whole file in slice 1. *Good:* one review. *Bad:* ships tables and RPCs for unbuilt features.

**O19. Supabase plan.**
- ★ (a) Free during build; revisit before real users. *Good:* $0. *Bad:* projects pause after a week idle, and the 500 MB database fills in about a year at the estimated rate.
- (b) Pro from day one. *Good:* no pausing, backups, Advanced MFA available. *Bad:* monthly cost.

**O20. Primary browser crypto provider** (MD D8, new in round 2).
- ★ (a) Vision first, OKX on failure. *Good:* `ACAO: *` and a documented weight budget. *Bad:* reachability for non-US residential browsers is unproven (preflights are not supported).
- (b) OKX first. *Good:* echoes any origin, and its order book sends `*`. *Bad:* no rate-limit headers, a ~100 KB all-tickers response, and global OKX is restricted for US residents.
- (c) Race both on the first cycle each session, then keep the faster healthy one. *Good:* adapts to each user's region. *Bad:* doubles the first-cycle load; more code.

### Lower-stakes defaults (taken unless you object)

| Area | Default | Alternative | Source |
|---|---|---|---|
| i18n routing | No `[locale]` segment; `en` hard-coded in `request.ts` | `[locale]` with prefixes | UI D1 |
| Symbol in URL | `?symbol=` + `history.replaceState` | `/spot/[symbol]` with static params | UI D3 |
| Drawing tools | Port the official Lightweight Charts plugin examples | Community library v0.1 | UI D5 |
| Admin auth operations | Server actions with `SUPABASE_SECRET_KEY` | Edge Function | UI D9 |
| Realtime transport | `postgres_changes` | Broadcast triggers to private channels | DM D8 |
| shadcn preset | `nova` on Radix | Another preset | scaffold |
