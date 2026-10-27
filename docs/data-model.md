# AureonX data model (Phase 1 proposal)

> **Merged 2026-10-25.** Where this doc conflicts with `docs/decisions.md`, `docs/decisions.md` wins.

> Status: **PROPOSED, NOT APPLIED.** The SQL is in `supabase/migrations/20261025000000_initial_schema.sql`.
> Scope: AureonX runs on **virtual funds**. Admins credit virtual balances, and no real money or chain transaction ever passes through the app.
> Research date: 2026-10-25. Sources are cited inline. They were read through the Supabase docs search tool because direct HTTP fetches of supabase.com are blocked from this sandbox.

---

## 0. Summary

- **Money:** cash is USDT, treated 1:1 as USD, and stored as `bigint` cents (`*_cents`). Asset quantities and prices are `numeric(38,18)`. They go in and out of RPCs as **decimal strings**. Rates are integer basis points (`*_bps`). No floats appear in any money path.
- **One mutation primitive:** every cash change goes through `private.wallet_apply()`, which updates the wallet and writes exactly one ledger row in the same transaction. Asset changes go through `private.holding_apply()`. A trigger rejects any other `UPDATE` of `wallets` or `spot_holdings`, even from the service role.
- **Clients can write no table.** All writes are `SECURITY DEFINER` RPCs with `set search_path = ''`. Reads go straight from the browser under RLS.
- **Prices are server-only.** The `price-ingest` Edge Function fetches public REST prices, then calls the service-role-only `ingest_prices`, which writes `price_snapshots`. Fills, option entry and settlement read only `price_snapshots`, with freshness checks. Missing, invalid or stale price → reject (`PRICE_STALE`) or skip (settlement). Nothing ever falls back to another price.
- **Settlement:** `pg_cron` runs every 10 s (Supabase ships pg_cron 1.6.4, and sub-minute schedules work). Settlement is idempotent: it claims rows with `SKIP LOCKED`, then makes a guarded `open → settled` transition, and only the winner of that transition credits. Settle-on-read (`settle_my_expired_options`) runs the same core and **takes no price argument**.
- **Verified locally:** the migration was loaded into a throwaway PostgreSQL 16 cluster with stubbed `auth`/`storage`/`vault`/`net` schemas. The money paths were exercised, including 6 concurrent settlers on 40 expired positions: each position was credited exactly once, there were no deadlocks, and `wallet == Σ ledger` held for every wallet. The cluster was deleted afterwards. Nothing was applied to any Supabase project.

---

## 1. Conventions

### 1.1 Units: which columns hold what

| Quantity | Type | Unit | Why |
|---|---|---|---|
| Cash balances, holds, fees, premiums, payouts, PnL, margins, deposit credits, withdrawal amounts | `bigint` | USDT cents (1 USDT = 100) | Integer math. Every sub-wallet is a single USDT cash balance, so one unit is used everywhere. USDT is treated as USD 1:1 in this app. Sub-cent precision (USDT has 6 on-chain decimals) has no product value here, and cents keep every balance in JS-safe integers (`2^53` cents ≈ $90 trillion). |
| Spot asset quantity (BTC, ETH, …) | `numeric(38,18)` | base units | Quantities need up to 18 decimals and arbitrary precision. In TS they are always strings. |
| Prices, limit prices, entry/settle/exit prices | `numeric(38,18)` | quote per base | These are rates, not balances. Converting to cents happens only at fill time, with explicit rounding. |
| Deposit `amount` (coin units the user typed) | `numeric(38,18)` | coin units | Informational. What is credited is `credit_cents`, which the admin sets (it defaults to `floor(amount × 100)` for USD-pegged coins). |
| Profit rate, fee rate | `integer` | basis points (`8500` = 85%) | Exact integer math. |

**Rounding always goes against the user**, which keeps the platform from creating money:
- buy cost = `ceil(qty × price × 100)`
- sell proceeds = `floor(qty × price × 100)`
- fee = `ceil(base × fee_bps / 10000)`
- option profit = `floor(premium × profit_rate_bps / 10000)` (integer division)
- forex PnL = `floor(margin × signed_return)`

The literal `10000.0` is a `numeric` constant in Postgres, not a float.

**Strings in, strings out.** RPC parameters for quantities and prices are `text`. `private.parse_decimal` accepts only `^[0-9]{1,20}(\.[0-9]{1,18})?$`, which rules out NaN, Infinity, exponents and negatives. **PostgREST serializes `numeric` as a JSON *number***, and `JSON.parse` turns that into a float. The UI must therefore select numeric columns with a cast (`select=qty::text,price::text,…`) or use the RPC return values only as triggers to refetch. (See §12: this conflicts with the UI map's assumption.)

### 1.2 Time
All timestamps are `timestamptz` from the DB's `now()`. The client never supplies a time that matters. `server_time()` exists for the UI countdown offset.

### 1.3 Idempotency
Every user write that creates a row takes `p_client_request_id uuid`, which the client generates once per user intent and reuses on retry. The tables enforce `unique (user_id, client_request_id)`.
1. The RPC takes the wallet lock first.
2. It then looks for an existing row with that key. If one exists and the parameters match, it returns the row. If they differ, it raises `IDEMPOTENCY_CONFLICT`.
3. Under READ COMMITTED each statement takes a fresh snapshot, so the lookup after the lock sees a concurrent duplicate that has already committed.

If the two calls lock *different* wallets (same key, different parameters), the unique index raises `23505`. The client should treat that as `IDEMPOTENCY_CONFLICT`.

Admin and review actions are idempotent through a guarded status transition. Repeating a review with the same outcome returns the row. A different outcome raises `REQUEST_NOT_PENDING`. `admin_adjust_balance` also takes a `client_request_id`, which is stored unique on `admin_audit_log`.

### 1.4 Lock ordering (deadlock avoidance)
Every function acquires locks in this order:
1. **The existing domain row** being transitioned (order, position or request), using `UPDATE … WHERE status = '<from>' RETURNING`. A batch (matcher, settler) uses `SELECT … FOR UPDATE SKIP LOCKED` instead, so batch workers never *wait* on a domain row.
2. **Wallets, ascending by `id`**, always through `private.lock_wallets(uuid[])` (`… ORDER BY id FOR UPDATE`).
3. **`spot_holdings`, ascending by `(user_id, asset)`.**
4. `profiles` (KYC only).

New rows (`INSERT`) take no ordering slot. No code path waits for a domain-row lock while holding a wallet lock: batch workers skip locked rows, and single-row transitions happen before any wallet lock. That rules out cycles. If Postgres still detects a deadlock (`40P01`), the transaction is aborted with no side effects, and the client retries with the same `client_request_id`.

### 1.5 Errors
Every function raises `RAISE EXCEPTION '<CODE>'` (SQLSTATE `P0001`), sometimes with a `DETAIL`. supabase-js exposes the code as `error.message`. The full list is in §11.

---

## 2. Architecture at a glance

```
Browser (Next static pages on Workers)
  ├─ reads ── supabase-js ──> PostgREST (RLS)        wallets, orders, positions, ledger, …
  ├─ writes ─ supabase.rpc ─> SECURITY DEFINER RPCs   (auth.uid() inside; never a price argument)
  ├─ live ─── Realtime postgres_changes (RLS-filtered, filter user_id=eq.<uid>)
  └─ display prices ─ market-data store (browser/Worker route; NOT trusted for money)

Supabase
  pg_cron "10 seconds" ─┬─> private.price_tick() ──pg_net──> Edge Function price-ingest
                        │      (only when demand)               ├─ fetch public REST tickers
                        │                                       ├─ rpc ingest_prices(jsonb)   (service_role)
                        │                                       ├─ rpc settle_due_options()   (service_role)
                        │                                       └─ rpc match_open_orders()    (service_role)
                        └─> settle_due_options(); match_open_orders();   (pure SQL safety net)
```

Next.js server code (server actions) is used only where a secret is needed, such as the admin `auth.admin.*` calls in the UI map's D9. **No money path runs in the Worker.**

---

## 3. Tables

All tables live in `public` and have RLS enabled. "own" means `user_id = auth.uid()`. Writes always happen through RPCs. No client role has any INSERT/UPDATE/DELETE grant.

### 3.1 `profiles`
| Column | Type | Notes |
|---|---|---|
| id | uuid PK → auth.users ON DELETE CASCADE | |
| uid | bigint UNIQUE, 10000000–99999999 | Public 8-digit UID, random, collision retry ×10 |
| email | text | Mirrored from `auth.users` by trigger (insert + email change) |
| nickname | text 1–32 | Defaults to `raw_user_meta_data.nickname` or `User####` |
| phone | text, loose E.164-ish CHECK | User-entered, not the auth phone |
| country | text `^[A-Z]{2}$` | |
| kyc_status | enum `none, pending, approved, rejected` | Changed only by `submit_kyc` / `admin_review_kyc` |
| created_at | timestamptz | |

Index: `lower(email)` (for admin search).

### 3.2 `user_roles`
`(user_id → auth.users, role app_role('admin'), granted_at, granted_by)`, PK `(user_id, role)`. This table is managed only by SQL or the dashboard. To bootstrap the first admin, insert a row by hand in the SQL editor.

### 3.3 `wallets` (cash)
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid → profiles | |
| account | enum `capital, spot, forex, options` | UNIQUE (user_id, account) |
| currency | text = 'USDT' | |
| available_cents | bigint ≥ 0 | |
| held_cents | bigint ≥ 0 | Frozen by open buy/forex limit orders and pending withdrawals |
| created_at, updated_at | timestamptz | |

The total balance is `available + held`. Rows are created by the signup trigger. The `wallets_guard_balance` trigger rejects any UPDATE unless it comes from `wallet_apply`.

### 3.4 `spot_holdings` (assets in the Spot sub-wallet)
PK `(user_id, asset)`. Columns: `available_qty numeric ≥0`, `held_qty numeric ≥0` (open sell orders), `cost_basis_cents bigint ≥0` (average-cost basis for realized PnL), `updated_at`. A row is created on first use. It carries the same guard trigger as `wallets`.

### 3.5 `markets` (public read)
| Column | Notes |
|---|---|
| id text PK | `'BTC-USDT'`, `'XAU-USD'`. The dash form matches the UI's `?symbol=` |
| kind | `spot` \| `forex` |
| display_name, base_asset, quote_asset | `'BTC/USDT'` |
| enabled, options_enabled | `options_enabled` = may be an options underlying (crypto only in the seed, see Open decision D2) |
| price_source, source_symbol | Provider key + provider symbol for the `price-ingest` function. **Placeholders (`TBD`) for the market-data agent** |
| qty_step, min_qty | Spot only. Qty must be a multiple of the step |
| price_tick | Limit prices must be a multiple |
| min_notional_cents | Spot notional / forex margin minimum |
| taker_fee_bps | Placeholder fees in the seed |
| max_price_age_s | 1–60, default **15**. Freshness required for fills and option entry |
| max_jump_bps | Ingest sanity band, default 20% vs the last snapshot within 5 min |
| sort_order | |

### 3.6 `price_snapshots` (authenticated read)
One row per market, **upserted**: `market_id PK → markets`, `price numeric CHECK (> 0, <> NaN, < Infinity)`, `fetched_at` (provider/fetch time, clamped to ≤ now()), `source`, `ingested_at`. The upsert only moves forward: `WHERE existing.fetched_at < excluded.fetched_at`.

Postgres `numeric` accepts `'NaN'`, and `NaN > 0` is **true** in Postgres ordering, so the explicit `<> 'NaN'` is required. The table keeps no history because nothing reads it: positions copy the price and timestamp they used (`entry_price_at`, `settle_price_at`, `fill_price_at`).

### 3.7 `cycle_config` (public read; admin write through the RPC)
`duration_s int PK (10–3600)`, `profit_rate_bps (0–100000)`, `fee_bps (0–1000)`, `min_premium_cents`, `max_premium_cents`, `premium_presets_cents bigint[]`, `enabled`, `updated_at`, `updated_by`.

The seed creates 30/60/90/120/300 with **placeholder zeros, `enabled = false`**. An admin must set real values before options can be traded. The rate is **copied onto each position at open**, so later changes affect only new positions. This table is in the Realtime publication so open terminals see admin edits.

### 3.8 `system_state` (admin read)
A singleton: `price_demand_until timestamptz`. Terminals and the settle-on-read path push it forward (at most one write per minute), and `price_tick` reads it.

### 3.9 `payment_networks` (public read)
PK `(asset, network)`. Columns: `usd_pegged`, `deposit_enabled`, `withdraw_enabled`, `min_deposit numeric`, `min_withdraw_cents`, `withdraw_fee_cents`, `sort_order`. **There is no deposit-address column** (see D1). The seed covers USDT/TRC20, USDT/ERC20, USDC/ERC20, BTC/BTC and ETH/ERC20, with placeholder fees.

### 3.10 `transfers`
`id, user_id, from_wallet_id, to_wallet_id, from_account, to_account, amount_cents > 0, client_request_id, created_at`. UNIQUE (user_id, client_request_id), CHECK from ≠ to. Index `(user_id, created_at desc)`. Each transfer writes two ledger rows (`transfer_out`, `transfer_in`) with `ref_id = transfers.id`.

### 3.11 `orders` (spot + forex)
| Column | Notes |
|---|---|
| id, user_id, wallet_id, market_id, market_kind | |
| side `buy/sell` | Forex: buy = long, sell = short |
| type `market/limit`, status `open/filled/canceled` | Market orders are never `open`. **Fills are all-or-nothing** (no partial fills in v1, so there is no `fills` table) |
| qty numeric | Spot only |
| margin_cents | Forex only (CHECK enforces exactly one of qty/margin by kind) |
| limit_price numeric | Required for limit orders |
| hold_cents / hold_qty | What was frozen while the order was open (kept for history) |
| fill_price, fill_price_at, quote_cents, fee_cents, realized_pnl_cents | Fill result. `fill_price_at` = timestamp of the snapshot used |
| client_request_id | UNIQUE per user |
| created_at, filled_at, canceled_at | |

Indexes: `(user_id, created_at desc)`, and a partial `(market_id, side, limit_price) WHERE status='open'` for the matcher.

### 3.12 `forex_positions`
`id, user_id, wallet_id, market_id, order_id UNIQUE, side long/short, margin_cents, open_fee_cents, entry_price, entry_price_at, opened_at, status open/closed, exit_price, exit_price_at, payout_cents, pnl_cents, closed_at`. Indexes: `(user_id, opened_at desc)`, partial `(user_id) WHERE status='open'`.

### 3.13 `options_positions`
| Column | Notes |
|---|---|
| id, user_id, wallet_id, market_id | |
| direction `rise/fall`, duration_s | |
| premium_cents, fee_cents, profit_rate_bps | The rate is a snapshot |
| entry_price, entry_price_at | From `price_snapshots` inside `open_option` |
| created_at, expires_at | Both from `now()` in the RPC. **CHECK `expires_at = created_at + duration_s seconds`** |
| status `open/settled`, result `win/loss/draw` | UI mapping: `won/lost/draw` = `result` when `status='settled'` |
| settle_price, settle_price_at | CHECK `settle_price_at >= expires_at` |
| payout_cents, pnl_cents, settled_at, settled_by `cron/read` | |
| client_request_id | UNIQUE per user |

Indexes: partial `(expires_at) WHERE status='open'` (settler), `(user_id, created_at desc)`.

### 3.14 `deposits`
`id, user_id, wallet_id (capital), asset, network (FK payment_networks), amount numeric > 0, tx_ref text ≤128 (free text, unverified), credit_cents (set on approve), status pending/approved/rejected, client_request_id, reviewed_by, reviewed_at, review_note, created_at`. CHECK: approved ⇒ credit_cents. Indexes: pending partial, `(user_id, created_at desc)`.

### 3.15 `withdrawals`
`id, user_id, wallet_id (capital), asset, network, address (10–128, no whitespace), amount_cents, fee_cents, status pending/approved/rejected/canceled, client_request_id, reviewed_*, created_at`. The same two indexes as deposits.

### 3.16 `kyc_submissions`
`id, user_id, first_name, last_name, date_of_birth, country, address jsonb, document_type (passport/id_card/driver_license), doc_front_path, doc_back_path (nullable), selfie_path, status pending/approved/rejected, client_request_id, reviewed_*, created_at`. A **partial unique index allows one pending submission per user**. There is also a pending queue index.

### 3.17 `ledger` ("Bills")
| Column | Notes |
|---|---|
| id bigint identity PK | Monotonic, so `(created_at, id)` keyset pagination works |
| user_id, wallet_id, account | Denormalized for filtering |
| kind | `transfer_in/out, deposit, withdrawal_hold/release/paid, admin_credit/debit, order_hold/release, spot_buy/sell, forex_margin, forex_close, option_premium, option_settle, fee` |
| delta_cents, held_delta_cents | Changes to `available_cents` and `held_cents` |
| balance_after_cents, held_after_cents | Both ≥ 0 |
| pnl_cents | Realized PnL recognized by this row (§8) |
| asset, asset_delta | Asset leg of spot fills (`+qty` buy / `−qty` sell); both null or both set |
| ref_type, ref_id | `transfer, order, forex_position, options_position, deposit, withdrawal, admin_adjustment` |
| actor_id | Admin for admin-initiated rows |
| memo, created_at | |

CHECK: a row must change something (cash, held, PnL or asset). Indexes: `(user_id, created_at desc, id desc)`, `(wallet_id, id)`, `(ref_type, ref_id)`, partial `(user_id, created_at) INCLUDE (pnl_cents) WHERE pnl_cents <> 0`.

### 3.18 `admin_audit_log` (admin read)
`id, admin_id, action, target_user_id, target_id, payload jsonb, client_request_id UNIQUE NULL, created_at`. Every admin RPC writes one row. For `admin_adjust_balance` the audit row id is the ledger `ref_id` and doubles as the idempotency record.

### 3.19 `favorites`
`(user_id, market_id)` PK. The UI uses it for market-list stars. It holds no money, and writes go through `toggle_favorite`.

Not included, on purpose: `fills` (no partial fills), `portfolio_snapshots` (see D4), `fiat_methods` (v1 is coin → network only), and price history.

---

## 4. RPC catalog

Legend:
- **D** = SECURITY DEFINER, **I** = SECURITY INVOKER.
- Every **D** function has `set search_path = ''` and fully qualified names.
- Callers: **auth** = `authenticated` (EXECUTE granted; `auth.uid()` required); **admin** = granted to `authenticated` but refused inside unless `private.is_admin()`; **svc** = `service_role` only (EXECUTE revoked from public/anon/authenticated).
- Lock-order numbers refer to §1.4.

### 4.1 User RPCs

| RPC | Sec / caller | Locks (in order) | Idempotency | Validation → errors |
|---|---|---|---|---|
| `transfer_between_wallets(p_from wallet_account, p_to wallet_account, p_amount_cents bigint, p_client_request_id uuid) → transfers` | D / auth | both wallets ascending | key on transfers | `UNAUTHENTICATED, INVALID_ARGUMENT, SAME_WALLET, INVALID_AMOUNT, WALLET_NOT_FOUND, INSUFFICIENT_FUNDS, IDEMPOTENCY_CONFLICT` |
| `place_spot_order(p_market_id text, p_side, p_type, p_qty text, p_limit_price text, p_client_request_id uuid, p_quote_cents bigint default null) → orders` | D / auth | spot wallet → holding(base) | key on orders | `MARKET_NOT_FOUND, MARKET_DISABLED, INVALID_NUMBER, INVALID_QTY (step/min), INVALID_PRICE (tick), BELOW_MIN_NOTIONAL, PRICE_STALE (market only), INSUFFICIENT_FUNDS, INSUFFICIENT_ASSET, IDEMPOTENCY_CONFLICT`. `p_quote_cents` is allowed only for a market buy without qty (the UI's % slider); the qty is floored to the step so that cost + fee ≈ quote. Rounding can exceed it by ≤ 2 cents, so the UI should pass `≤ available − 2`. |
| `place_forex_order(p_market_id, p_side, p_type, p_margin_cents bigint, p_limit_price text, p_client_request_id) → orders` | D / auth | forex wallet | key on orders | Same set as spot (no qty errors) |
| `cancel_order(p_order_id uuid) → orders` | D / auth | order (guarded `open→canceled`) → wallet → holding | Re-cancel returns the canceled row | `ORDER_NOT_FOUND, ORDER_NOT_OPEN` (already filled) |
| `close_forex_position(p_position_id uuid) → forex_positions` | D / auth | position (guarded `open→closed`) → wallet | Re-close returns the closed row; a concurrent close credits once | `POSITION_NOT_FOUND, PRICE_STALE` |
| `open_option(p_market_id text, p_direction, p_duration_s int, p_premium_cents bigint, p_client_request_id uuid) → options_positions` | D / auth | options wallet | key on positions | `MARKET_NOT_FOUND, MARKET_DISABLED (incl. options_enabled=false), CYCLE_NOT_FOUND, CYCLE_DISABLED, PREMIUM_OUT_OF_RANGE, PRICE_STALE, INSUFFICIENT_FUNDS, IDEMPOTENCY_CONFLICT`. Debits premium and fee as two ledger rows. `created_at` is the server time and can serve as `server_now`. |
| `settle_my_expired_options() → jsonb {settled, pending}` | D / auth | positions (SKIP LOCKED) → wallets ascending | Guarded transition | **No price parameter.** Settles only the caller's expired positions, with the cron rules. If `pending > 0` it bumps the price demand. |
| `request_price_feed() → timestamptz` | D / auth | none (singleton update ≤ 1/min) | Naturally idempotent | Called on terminal mount and every ~4 min while visible |
| `request_deposit(p_asset, p_network, p_amount text, p_client_request_id, p_tx_ref text default null) → deposits` | D / auth | none (no balance change) | key; unique-violation → return existing | `NETWORK_DISABLED, INVALID_NUMBER, BELOW_MINIMUM, TOO_MANY_PENDING (≥5)` |
| `request_withdrawal(p_asset, p_network, p_address, p_amount_cents, p_client_request_id) → withdrawals` | D / auth | capital wallet | key | `KYC_REQUIRED, MFA_REQUIRED (verified factor and not AAL2), NETWORK_DISABLED, BELOW_MINIMUM, INVALID_ADDRESS, INVALID_AMOUNT, INSUFFICIENT_FUNDS, IDEMPOTENCY_CONFLICT`. **Holds** amount + fee (`withdrawal_hold`). |
| `cancel_withdrawal(p_withdrawal_id) → withdrawals` | D / auth | withdrawal (guarded `pending→canceled`) → wallet | Re-cancel returns the row | `REQUEST_NOT_FOUND, REQUEST_NOT_PENDING`. Releases the hold. |
| `submit_kyc(p_first_name, p_last_name, p_date_of_birth date, p_country, p_document_type, p_doc_front_path, p_doc_back_path, p_selfie_path, p_client_request_id, p_address jsonb default null) → kyc_submissions` | D / auth | profile FOR UPDATE (serializes per user) | key | `KYC_ALREADY_PENDING, KYC_ALREADY_APPROVED, KYC_INVALID_DOB (<18), KYC_PATH_INVALID (path not under `<uid>/` or contains `..`), KYC_FILE_MISSING (no object in bucket `kyc`)`. Sets `profiles.kyc_status='pending'`. |
| `update_profile(p_nickname, p_phone, p_country) → profiles` | D / auth | none | Naturally idempotent | CHECK violations (`23514`) for a bad phone or country |
| `toggle_favorite(p_market_id) → boolean` | D / auth | none | Toggle | `MARKET_NOT_FOUND` |
| `server_time() → timestamptz` | I / anon, auth | none | none | none |
| `get_pnl_series(p_range '1D'\|'1W'\|'1M'\|'6M') → (bucket, pnl_cents, cumulative_cents)` | I / auth (RLS) | none | none | An unknown range returns 0 rows. Buckets: hour / day / day / week. Empty buckets are not emitted, so the UI fills the gaps. |
| `get_options_stats(p_since timestamptz default null) → per duration_s: trades, wins, losses, draws, premium, fee, pnl` | I / auth (RLS) | none | none | none |

### 4.2 Admin RPCs (granted to `authenticated`; first statement is `if not private.is_admin() then raise 'FORBIDDEN'`)

| RPC | Locks | Idempotency | Effect / errors |
|---|---|---|---|
| `admin_review_deposit(p_deposit_id, p_approve bool, p_credit_cents bigint default null, p_note text default null) → deposits` | deposit (guarded `pending→approved/rejected`) → capital wallet | Same outcome again → returns the row | Approve credits `credit_cents`. It defaults to `floor(amount×100)` for `usd_pegged` networks; otherwise it is required (`CREDIT_AMOUNT_REQUIRED`). Max 1e11 cents. Reject requires a note (`NOTE_REQUIRED`). Errors: `REQUEST_NOT_FOUND, REQUEST_NOT_PENDING, INVALID_AMOUNT`. Writes an audit row. |
| `admin_review_withdrawal(p_withdrawal_id, p_approve, p_note) → withdrawals` | withdrawal (guarded) → capital wallet | Same outcome again → returns the row | Approve: `withdrawal_paid` (held −amount) plus `fee` (held −fee). The virtual funds leave the platform and nothing is sent anywhere. Reject: `withdrawal_release` (available +, held −). Reject needs a note. |
| `admin_adjust_balance(p_user_id, p_account, p_delta_cents, p_reason, p_client_request_id) → admin_audit_log` | target wallet | `client_request_id` UNIQUE on audit log | Credit or debit **available** only. A debit can never touch held funds (`INSUFFICIENT_FUNDS`). `INVALID_AMOUNT` (0 or > 1e11), `NOTE_REQUIRED` (reason < 3 chars), `WALLET_NOT_FOUND`, `IDEMPOTENCY_CONFLICT`. |
| `admin_review_kyc(p_submission_id, p_approve, p_note) → kyc_submissions` | submission (guarded) → profile | Same outcome again → returns the row | Sets `profiles.kyc_status`. Reject needs a note. |
| `admin_set_cycle_config(p_duration_s, p_profit_rate_bps, p_fee_bps, p_min_premium_cents, p_max_premium_cents, p_premium_presets_cents bigint[], p_enabled) → cycle_config` | none (upsert) | Upsert | `INVALID_ARGUMENT` when a value is out of range or a preset falls outside [min, max]. Writes an audit row. Open positions keep their snapshotted rate. |

### 4.3 Service RPCs (`service_role` only)

| RPC | Called by | Locks | Behaviour |
|---|---|---|---|
| `ingest_prices(p_prices jsonb) → {accepted, rejected}` | Edge Function | snapshot row (upsert) | Input `[{market_id, price: "<decimal string>", source, ts?}]`. Skips: unknown or disabled market, a non-string price, unparsable/≤0/NaN/Infinity values, `ts` > now+5 s or < now−60 s, and a jump > `max_jump_bps` vs a snapshot younger than 5 min (logged). `fetched_at = least(ts, now())`. The upsert only moves forward in time. |
| `settle_due_options(p_limit int default 500) → {settled, pending}` | Edge Function after ingest; pg_cron every 10 s | positions SKIP LOCKED → wallets ascending | See §7. |
| `match_open_orders(p_limit int default 200) → int` | Edge Function after ingest; pg_cron every 10 s | orders SKIP LOCKED → wallets ascending → holdings ascending | Fills resting limits whose limit a **fresh** price has crossed, provided the price was observed **after the order was created** (`fetched_at >= created_at`, so no look-back). The fill happens **at the limit price**. Buy fills when snapshot ≤ limit; sell when ≥ limit. |

### 4.4 Private helpers (schema `private`; not exposed by PostgREST; no EXECUTE for client roles, except `is_admin`)
- `is_admin()`
- `parse_decimal(text)`
- `lock_wallets(uuid[])`
- `wallet_apply(...)`: the only cash writer
- `lock_holding(user, asset)`
- `holding_apply(...)`: the only asset writer
- `fresh_price(market, max_age_s)`: returns price and fetched_at, or NULLs
- `touch_price_demand()`
- `apply_spot_fill(order, price, price_at, from_hold)`
- `apply_forex_fill(...)`
- `settle_options(user|null, limit, settled_by)`
- `price_tick()`
- `handle_new_user()`
- `handle_user_email_change()`
- `guard_balance_write()`

### 4.5 Auth hook
`public.custom_access_token_hook(event jsonb)` adds a top-level JWT claim `user_role: "admin" | "user"`, read from `user_roles`. It is for **routing only** (the UI proxy). SQL authorization always calls `private.is_admin()`, which reads the table live, so revoking an admin takes effect immediately in the database even while an old JWT is still valid. Enable it in Dashboard → Authentication → Hooks. Only `supabase_auth_admin` may execute it.

---

## 5. Trading models (internal matching)

### 5.1 Spot
- **Market order:** fills immediately and in full at the latest `price_snapshots` price, provided it is ≤ `max_price_age_s` (15 s) old. Otherwise `PRICE_STALE` and nothing is written. There is no slippage or order-book walk: balances are virtual, and the price the user saw differs from the fill price by at most the snapshot age.
- **Limit order:** if it is marketable against a fresh snapshot at placement, it fills immediately at the snapshot price, which is never worse than the limit. Otherwise it **rests**: a buy freezes `ceil(qty×limit×100) + fee` cash (the fee is frozen at placement), and a sell freezes `qty`. `match_open_orders` fills it **at the limit price** once a later fresh price crosses it. Resting orders never fail on a stale price; they just wait.
- **Why fill at the limit and not the crossing price?** It is simple and conservative, the hold is exact (no refunds), and users get no price improvement they could game from snapshot gaps.
- **Realized PnL:** a buy adds cost plus fee to `cost_basis_cents`. A sell removes `floor(basis × qty / (available+held))` of basis, and realized PnL = proceeds − fee − removed basis.

### 5.2 Forex (recommended v1 model; see D3)
These are **percentage-return positions with no leverage**. The user commits USDT `margin_cents` long (buy) or short (sell) at a fresh server price. On close at a fresh server price:

`pnl = floor(margin × ±(exit − entry) / entry)`, `payout = max(margin + pnl, 0)`

This works for every pair, including non-USD-quoted ones (CAD/JPY, AUD/JPY), with no FX conversion and a single USDT wallet. Losses are capped at the margin, so balances can never go negative and no liquidation engine is needed. Market and limit entry follow the spot rules; the limit hold is margin + fee. A close is always at market. v1 has no TP/SL.

### 5.3 Options ("I expect X will Rise/Fall")
1. `open_option` reads `cycle_config` (enabled, min/max premium, `profit_rate_bps`, `fee_bps`), takes the entry price from a snapshot ≤ 15 s old, and sets `created_at = now()` and `expires_at = now() + duration`.
2. It debits the premium, then the fee (`ceil(premium × fee_bps / 10000)`).
3. At settlement:
   - **Win** (rise and settle > entry, or fall and settle < entry): payout = premium + `floor(premium × rate / 10000)`.
   - **Draw** (settle = entry): the premium is refunded and the fee is kept (D7).
   - **Loss:** payout 0.

The UI computes the "expected profit" and fee it shows live with the same formulas from `cycle_config`; the server recomputes them.

---

## 6. Ledger design

**Single-entry with balance-after, one row per wallet mutation.** This was chosen over double-entry because it is the simplest scheme that still guarantees:
1. **Every balance movement has a ledger row in the same transaction.** `wallet_apply` is the only code that can update `wallets` (the guard trigger plus no client grants). It always inserts the ledger row after the update, inside the caller's transaction, so if either fails, both roll back.
2. **Replayability.** For every wallet, `available_cents = Σ delta_cents` and `held_cents = Σ held_delta_cents`. `balance_after_cents` is written while the row lock is held, so the sequence per wallet is strictly ordered by `id`. The local test checked this invariant for all wallets after the concurrency run.
3. **Non-negativity** is enforced three times: by a pre-check (to return a friendly `INSUFFICIENT_FUNDS`), by `CHECK (available_cents >= 0, held_cents >= 0)`, and by the ledger's `balance_after_cents >= 0`.
4. **Inter-wallet transfers** write two rows that share `ref_id = transfers.id`.

Double-entry would add a platform or counterparty account per movement and double the rows, and in a single-tenant virtual-funds app nothing would ever reconcile against it.

**Holds are ledger rows.** `order_hold`, `withdrawal_hold` and their releases or consumption show "frozen" movements in Bills. Spot **asset** holds (sell limits) are not ledger rows: the order row is the record, and the fill's ledger row carries the asset leg.

Reconciliation query for an admin health check:
```sql
select w.id from public.wallets w
join lateral (select coalesce(sum(delta_cents),0) a, coalesce(sum(held_delta_cents),0) h
              from public.ledger l where l.wallet_id = w.id) s on true
where w.available_cents <> s.a or w.held_cents <> s.h;   -- must return 0 rows
```

---

## 7. Settlement and price pipeline

### 7.1 pg_cron resolution: finding
- **Supabase ships pg_cron 1.6.4.** "The current version of `pg_cron` on Supabase is 1.6.4" (<https://supabase.com/docs/guides/troubleshooting/pgcron-debugging-guide-n1KTaz>).
- **Sub-minute schedules are supported, down to 1 second.** "You can use [1-59] seconds (e.g. `30 seconds`) as the cron syntax to schedule sub-minute Jobs." and "You can input seconds for your Job schedule interval as long as you're on Postgres version 15.1.1.61 or later." (<https://supabase.com/docs/guides/cron/quickstart>). Supabase Cron jobs "can run anywhere from every second to once a year" (<https://supabase.com/docs/guides/cron>). Seconds syntax arrived in pg_cron 1.5.
- **Limits:** "we recommend no more than 8 Jobs run concurrently. Each Job should run no more than 10 minutes" (<https://supabase.com/docs/guides/cron>). "pg_cron supports up to 32 concurrent jobs, each using a database connection" (debugging guide). `cron.job_run_details` "are not cleaned up automatically" (quickstart), so a cleanup job is needed: 10 s schedules write about 8,640 rows per job per day.
- (The pg_net page still says pg_cron calls endpoints "with up to a minute precision". That page is outdated; the Cron docs above are authoritative.)
- **Chosen interval: 10 seconds.** 1–5 s would multiply Edge Function invocations (§10) for little benefit, because the settlement delay is dominated by the fetch interval anyway.

### 7.2 Options evaluated for the async-fetch problem
pg_net is asynchronous: "HTTP requests are not started until the transaction is committed", and responses land in `net._http_response`, an unlogged table with a 6 h TTL (<https://supabase.com/docs/guides/database/extensions/pg_net>). A single SQL transaction therefore cannot fetch a price and then use it.

| Option | How | Good | Bad |
|---|---|---|---|
| **(a) cron → pg_net → Edge Function → `ingest_prices` + `settle_due_options` + `match_open_orders` (RECOMMENDED)** | The cron SQL only fires an HTTP POST. The Edge Function (TypeScript) fetches REST tickers, validates them, and calls the service-role RPCs, which read `price_snapshots` with freshness rules | Parsing and provider logic live in testable TS. Settlement runs right after a fresh ingest (low latency). The DB never trusts the HTTP response directly; it trusts only its own snapshot table and checks. Provider failover lives in one place. | Counts Edge invocations (budgeted below). A cold start adds ~0.2–1 s. Needs a Vault secret plus a shared header secret. |
| (b) cron job 1 fires `net.http_get` per provider; job 2 parses `net._http_response` in SQL | Pure SQL | No Edge invocations | Provider JSON parsing in SQL. Request-id correlation and timing between jobs. Responses are unlogged and lost on a crash. Harder to test. Keep only as a fallback if the invocation quota is exceeded. |
| (c) Worker route / browser pushes prices | n/a | n/a | **Rejected:** client-trusted prices, and an external scheduler. |

### 7.3 Recommended flow and failure modes
```
t=0      user ─rpc open_option──────────────> DB: snapshot age ≤15s? ─no─> PRICE_STALE
                                               └─yes─> insert position(entry=snapshot, expires=now()+30s), debit
t+10s.. pg_cron "10 seconds" ──> private.price_tick()
                                   demand? (open option | demand_until>now | open limit orders: 1/min)
                                   └─yes─> net.http_post(project_url/functions/v1/price-ingest, x-aureonx-cron-secret)
         (after commit)  pg_net worker ──POST──> Edge Function price-ingest
                                                   verify header secret (deployed --no-verify-jwt)
                                                   GET public REST tickers (3 s timeout, provider per market)
                                                   rpc ingest_prices([{market_id, price:"…", ts}])  (service_role)
                                                   rpc settle_due_options()                        (service_role)
                                                   rpc match_open_orders()                         (service_role)
         pg_cron "10 seconds" ──> settle_due_options(); match_open_orders();   (SQL safety net, no HTTP)
t≈30–42s settle: claim open & expires_at<=now() & snapshot.fetched_at>=expires_at
                  & fetched_at>now()-60s (FOR UPDATE SKIP LOCKED)
                  → lock wallets ascending → UPDATE … SET status='settled' WHERE id=$1 AND status='open'
                  → only if a row was updated: wallet_apply(payout)  → Realtime UPDATE → UI
fallback  UI countdown hits 0 and no update arrives → rpc settle_my_expired_options()
          (same core, no price argument; if still pending → bump demand)
```

**Settlement price rules** (all must hold, otherwise the position stays `open` and is retried on the next tick):
- `price > 0`, not NaN, finite (CHECK and parser);
- `fetched_at >= expires_at`: the price was observed at or after expiry, never before;
- `fetched_at > now() − 60 s` and `<= now()`.

There is **never** a fallback to a random, synthetic, last-known-good or client price.

**Entry freshness at open time.** Snapshots refresh every 10 s while demand exists, so a snapshot's age is about 0–11 s and `max_price_age_s = 15` normally passes. After an idle period (no demand), the first `open_option` within about 10 s of opening the terminal gets `PRICE_STALE`. To prevent this, the terminal calls `request_price_feed()` on mount, and the next tick (≤ 10 s) warms the feed; the UI shows "syncing price" until a fresh snapshot exists. The UI can poll `price_snapshots.fetched_at` once, or subscribe. The residual risk is that a 30 s option's entry price can be up to about 11 s old while the user watches a live feed, which gives a small look-ahead edge. That is acceptable for virtual funds; D5 lists the stricter variant.

**Failure modes:**

| Failure | Effect | Recovery |
|---|---|---|
| Provider down / timeout / 5xx | No snapshot update → snapshots go stale | Opens and market orders get `PRICE_STALE`; settlement is skipped; nothing is debited or credited wrongly. It recovers on the next good tick. The Edge Function should try a secondary provider per market (market-data agent). |
| Provider returns a garbage price | `ingest_prices` rejects unparsable, ≤0, out-of-window or >20 % jump values (logged) | Same as above. The jump filter self-heals after 5 min (the reference snapshot ages out). |
| Edge Function cold start or crash | Tick lost | The next tick 10 s later. The pure-SQL cron job still settles with any fresh snapshot. |
| Vault secrets missing | `price_tick` logs and returns | Visible in the Postgres logs. No price, so no settlement (safe). |
| pg_cron scheduler dies | No ticks | Settle-on-read still runs but needs a fresh price, so positions stay open until cron is revived (1.6.4 auto-revives; otherwise fast reboot per the debugging guide). |
| Long outage (> 60 s) | Positions settle later, at the first fresh price ≥ expiry | D6: auto-void after N minutes, if wanted. |
| Two settlers race (cron vs read vs Edge) | SKIP LOCKED plus the guarded transition | Exactly one credit (tested with 6 concurrent settlers). |
| Clock skew between provider and DB | `ts` > now + 5 s rejected; `fetched_at = least(ts, now())` | n/a |
| Someone calls the Edge Function URL | It rejects requests without the shared header secret | Even a valid call can only fetch real public prices; it cannot inject a price. |

### 7.4 Forex/metal prices
**Frankfurter serves ECB reference rates, published once per working day. It cannot be used for 30 s options settlement or for fills**: a stale daily rate makes trades predictable. In the schema, `max_price_age_s` is capped at 60 s, so a daily source can never satisfy a fill or entry check. The seed therefore sets all forex/metal markets to `options_enabled = false`. Forex market orders return `PRICE_STALE` until an intraday source (≤ 15–60 s) is wired into `price-ingest`. See D2.

---

## 8. Profit chart (1D/1W/1M/6M)

**Recommended v1: realized PnL from the ledger.** Every ledger row carries `pnl_cents`, set so that summing it gives realized PnL net of fees:

| Row | `pnl_cents` |
|---|---|
| `option_settle` | `payout − premium − fee` (a loss writes a zero-cash row that carries only PnL) |
| `forex_close` | `payout − margin − open_fee` |
| `spot_sell` | `proceeds − removed basis` |
| sell `fee` row | `−fee` |
| buy fees | 0 (capitalized into basis) |
| premium/margin debits, transfers, deposits, admin adjustments | 0 |

`get_pnl_series(range)` is one indexed aggregate over the partial index `ledger_user_pnl_idx` (only rows with PnL), bucketed hour/day/day/week, with a running cumulative sum. At 10 users it reads a few hundred rows. It needs no cron, no extra table and no historical prices. Deposits and admin credits never count as profit. Limitation: unrealized PnL on open spot holdings and forex positions is not included; the UI can add the live unrealized value of open positions client-side. See D4 for the alternative the UI map proposed.

---

## 9. RLS, grants and storage

### 9.1 Per-table policies
"own" = `user_id = (select auth.uid())`; admin = `(select private.is_admin())`. Both are wrapped in `select` so the planner evaluates them once per statement.

| Table | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| profiles | own (`id`) or admin | -- (trigger) | -- (`update_profile` RPC) | -- (cascade from auth.users) |
| user_roles | own or admin; `supabase_auth_admin` (hook) | -- | -- | -- |
| wallets, spot_holdings | own or admin | -- | -- (RPC + guard trigger) | -- |
| transfers, orders, forex_positions, options_positions, deposits, withdrawals, kyc_submissions, ledger | own or admin | -- | -- | -- |
| favorites | own | -- (RPC) | -- | -- (RPC) |
| admin_audit_log, system_state | admin | -- | -- | -- |
| markets, payment_networks, cycle_config | anon + authenticated | -- | -- | -- |
| price_snapshots | authenticated | -- (svc RPC) | -- | -- |

"--" means no policy **and** no grant. The migration revokes ALL table privileges from `anon`/`authenticated` (Supabase's default privileges grant them), re-grants only SELECT, and alters the default privileges so future tables start closed too. `service_role` bypasses RLS but still cannot update balances directly because of the guard trigger.

Functions: EXECUTE is revoked from `public, anon, authenticated` on every function in `public` and `private` (and through default privileges). It is then granted explicitly per §4. Service RPCs are granted only to `service_role`.

### 9.2 Admin helper and why it doesn't recurse
`private.is_admin()` is `language sql stable security definer set search_path = ''` and returns `exists(select 1 from public.user_roles where user_id = (select auth.uid()) and role = 'admin')`. It runs as the function owner (`postgres`), who owns `user_roles` and therefore bypasses its RLS (the table is **not** `FORCE ROW LEVEL SECURITY`). That means the `user_roles` SELECT policy, which itself calls `is_admin()`, is never evaluated inside `is_admin()`, so there is no recursion. It lives in the unexposed `private` schema: `authenticated` gets `USAGE` on the schema and EXECUTE on this one function so policies can call it, but it is not an RPC endpoint. The UI learns admin status from the `user_role` JWT claim or by reading its own `user_roles` row.

### 9.3 Storage (KYC)

> **Superseded (locked in Phase 2):** no KYC file is stored anywhere, so there is no `kyc` bucket and `submit_kyc` takes no file paths. The admin reviews text fields only. This section is kept only as a record of the earlier proposal.
- **Bucket `kyc`:** private, 10 MiB limit, `image/jpeg, image/png, image/webp, application/pdf`.
- **Paths:** `<auth.uid()>/<anything>`. The client uploads directly from the browser with `upsert: false`.

| storage.objects policy | Rule |
|---|---|
| INSERT (authenticated) | `bucket_id = 'kyc' and (storage.foldername(name))[1] = auth.uid()::text` |
| SELECT (authenticated) | Same prefix **or** `is_admin()`. Admins view files through `createSignedUrl` (60 s) |
| UPDATE / DELETE | None. Files are immutable for users, and a resubmission after rejection uses new file names |

`submit_kyc` re-checks the path prefix and that the object exists, so a user cannot reference another user's files.

### 9.4 Signup trigger
`on_auth_user_created` (AFTER INSERT ON `auth.users`) → `private.handle_new_user()` (SECURITY DEFINER):
1. Inserts the profile with a random 8-digit UID, retrying up to 10× on a unique collision.
2. Inserts the 4 zero-balance wallets.

It does nothing else: no HTTP, no welcome credit. Virtual funds are credited by an admin, and if auto-credit is wanted later it should be an explicit `admin_adjust_balance`-style function, not more trigger logic. **If the trigger fails, the signup fails** (Auth returns "Database error saving new user"). That is deliberate: a user without wallets would break every RPC. The trigger is kept tiny so it cannot fail for business reasons. A second trigger mirrors email changes into `profiles.email`.

---

## 10. Realtime

The following tables are added to the `supabase_realtime` publication:
- `wallets`, `spot_holdings`
- `orders`, `forex_positions`, `options_positions`
- `deposits`, `withdrawals`, `kyc_submissions`
- `profiles` (kyc_status changes)
- `cycle_config` (admin edits, all rows)

Clients use `postgres_changes` with `filter: user_id=eq.<uid>` (`id=eq.<uid>` for profiles).

How RLS interacts with Realtime:
- **RLS is applied per subscriber** for postgres_changes, so every change is authorized for each listening client. "Database changes are processed on a single thread" (<https://supabase.com/docs/guides/realtime/postgres-changes>). That is fine at this scale.
- "RLS policies are not applied to `DELETE` statements". That doesn't matter here, because these tables never delete rows (except cascades from user deletion).

Deliberately **not** published:
- `ledger`: Bills refetch the first page when a wallet event arrives.
- `price_snapshots`: see the message math below.
- `admin_audit_log`.

The admin queues can subscribe to `deposits`/`withdrawals`/`kyc_submissions` inserts. The admin RLS policy lets them see all rows, at the cost of one extra message per change per open admin tab.

Upgrade path: broadcast-from-trigger to private `user:<uid>` channels (D8) when user counts grow.

---

## 11. Error codes

| Code | Meaning |
|---|---|
| `UNAUTHENTICATED` | No `auth.uid()` |
| `FORBIDDEN` | Admin RPC called by a non-admin |
| `INVALID_ARGUMENT` | Missing or contradictory parameters |
| `INVALID_NUMBER` | Decimal string failed the strict parser |
| `INVALID_AMOUNT` | Cents ≤ 0 or above the sanity cap |
| `INVALID_QTY` / `INVALID_PRICE` | Not a step/tick multiple, or below `min_qty` |
| `INVALID_ADDRESS` | Withdrawal address format |
| `BELOW_MIN_NOTIONAL` / `BELOW_MINIMUM` | Below the market notional / network minimum |
| `SAME_WALLET` | Transfer from = to |
| `WALLET_NOT_FOUND` / `PROFILE_NOT_FOUND` / `HOLDING_NOT_FOUND` | Missing row |
| `INSUFFICIENT_FUNDS` / `INSUFFICIENT_ASSET` | Available balance / qty too low (DETAIL has the numbers) |
| `MARKET_NOT_FOUND` / `MARKET_DISABLED` | Unknown market; disabled, or `options_enabled = false` |
| `PRICE_STALE` | No valid server snapshot within `max_price_age_s` |
| `CYCLE_NOT_FOUND` / `CYCLE_DISABLED` / `PREMIUM_OUT_OF_RANGE` | Options config |
| `ORDER_NOT_FOUND` / `ORDER_NOT_OPEN` | Cancel |
| `POSITION_NOT_FOUND` | Forex close |
| `REQUEST_NOT_FOUND` / `REQUEST_NOT_PENDING` | Deposit/withdrawal/KYC review or cancel |
| `TOO_MANY_PENDING` | ≥ 5 pending deposits |
| `NETWORK_DISABLED` | Coin/network not enabled for this direction |
| `KYC_REQUIRED` / `MFA_REQUIRED` | Withdrawal gating |
| `KYC_ALREADY_PENDING` / `KYC_ALREADY_APPROVED` / `KYC_INVALID_DOB` / `KYC_PATH_INVALID` / `KYC_FILE_MISSING` | KYC |
| `CREDIT_AMOUNT_REQUIRED` | Approving a non-pegged deposit without `p_credit_cents` |
| `NOTE_REQUIRED` | Reject or adjustment without a reason |
| `IDEMPOTENCY_CONFLICT` | Same `client_request_id`, different parameters (also map `23505` to this) |
| `DIRECT_BALANCE_WRITE_FORBIDDEN` | Guard trigger: a bug, never expected in production |
| `INVARIANT_*` | Internal consistency failure: a bug, alert on it |

---

## 12. Mapping to the UI map (`docs/ui-map.md` §9.1) and conflicts

| UI map expects | This model | Note |
|---|---|---|
| `instruments(symbol 'BTC-USDT', category…)` | `markets(id 'BTC-USDT', kind spot/forex, options_enabled)` | Same id format. "Options symbols" are spot rows with `options_enabled = true` |
| `wallets(user_id, wallet, asset, available numeric, locked numeric)` | `wallets` (one USDT cents row per sub-wallet) + `spot_holdings` (numeric qty) | The Forex and Options wallets hold only USDT in this model |
| `ledger_entries(amount numeric, …)` | `ledger(delta_cents, held_delta_cents, balance_after_cents, asset_delta, pnl_cents, …)` | Keyset on `(created_at, id)` works |
| `orders` with partial fills + `fills` | `orders` all-or-nothing, fill columns inline | The "Fills" tab = `orders where status='filled'` |
| `option_cycles(seconds, profit_rate numeric, fee_rate numeric …)` | `cycle_config(duration_s, profit_rate_bps, fee_bps, …)` | Integer bps, not numeric rates |
| `option_orders(status open/won/lost/draw/canceled)` | `options_positions(status open/settled, result win/loss/draw)` | No cancel in v1 |
| `place_option_order → {order, server_now}` | `open_option → options_positions` | `created_at` is the server time; `server_time()` exists |
| `asset_networks(deposit_address …)` | `payment_networks` (no address) | **Conflict, D1.** The UI's AddressDisplay step must change |
| `deposit_requests` / `withdrawal_requests`, `create_*_request`, `cancel_withdrawal_request` | `deposits` / `withdrawals`, `request_deposit`, `request_withdrawal`, `cancel_withdrawal` | Names only |
| `portfolio_snapshots` (hourly cron) | `get_pnl_series()` over `ledger.pnl_cents` | **Conflict, D4** |
| D6-A: forex = same as spot | Forex = margin positions (no leverage) | **Conflict, D3.** The order form can stay; "Amount" becomes USDT margin, and Buy/Sell become Long/Short |
| `is_admin()` reading JWT `app_metadata.role` | `private.is_admin()` reads `user_roles`; the JWT gets the top-level `user_role` claim via the auth hook | The proxy should read `user_role`, not `app_metadata.role` |
| "PostgREST returns numeric as strings" | **It returns JSON numbers** | The UI must cast `::text` in selects (§1.1) |
| `admin_upsert_option_cycle`, `get_option_stats(range)` | `admin_set_cycle_config`, `get_options_stats(p_since)` | Names only |
| `favorites` + `toggle_favorite`, `update_profile`, `server_time`, `admin_audit_log`, MFA-gated withdrawals, KYC for withdrawals (D7-A) | Included as requested | |

---

## 13. Open decisions

| # | Decision | Options (★ = recommended) |
|---|---|---|
| D1 | **What the deposit "address" means when funds are virtual** | ★ **(a) Show no receiving address.** The deposit is a virtual-credit request (coin → network → amount → optional reference), clearly labeled "Virtual funds: no real funds are received". *Good:* nobody can send real crypto to a platform that can't credit it. *Bad:* less realistic UX. · (b) Show a fixed placeholder labeled "NOT A REAL ADDRESS, DO NOT SEND". *Good:* realistic stepper. *Bad:* it looks like a real address and someone will send funds. · (c) A real platform address. *Bad:* implies real custody, plus legal/regulatory exposure; rejected. |
| D2 | **Forex/metal price source** | ★ **(a) v1: forex/metals are trade-only once an intraday (≤ 60 s) source exists, and excluded from options.** *Good:* no stale-price exploits. *Bad:* the forex terminal is inert until the market-data agent finds a source. · (b) A free intraday FX/metal API in `price-ingest`. *Good:* full feature set. *Bad:* availability, rate limits and terms unverified (the UI agent saw several blocked). · (c) Frankfurter/ECB daily rates. *Good:* free and stable. *Bad:* daily rates are unusable for fills or 30 s settlement (the schema caps freshness at 60 s); display or valuation only. |
| D3 | **Forex order model** | ★ **(a) Percentage-return positions, no leverage.** *Good:* works for JPY/CAD-quoted pairs with one USDT wallet; losses capped; no liquidation. *Bad:* not "real" FX. · (b) Spot-like conversion (UI D6-A). *Good:* reuses the spot form exactly. *Bad:* needs multi-currency forex balances (JPY, CAD, XAU …) and FX valuation, which breaks the single-currency-cents rule. · (c) Leveraged margin with SL/TP and liquidation. *Bad:* engine plus edge cases; out of v1. |
| D4 | **Profit chart source** | ★ **(a) Realized PnL from `ledger.pnl_cents`.** *Good:* exact, zero extra writes, excludes deposits by construction. *Bad:* no unrealized component. · (b) Hourly `portfolio_snapshots` (UI D8) net of external flows. *Good:* includes unrealized PnL. *Bad:* needs server prices for every held asset every hour, a new table and cron, and deposits must be netted out. · (c) Client-computed. *Bad:* historical holdings can't be valued without historical prices. |
| D5 | **Options entry price** | ★ **(a) Latest snapshot ≤ 15 s old.** *Good:* immediate entry price, simple. *Bad:* up to about 11 s look-ahead edge vs the live feed. · (b) Deferred entry: the position opens "pending entry" and takes the first snapshot with `fetched_at ≥ created_at`. *Good:* no look-ahead. *Bad:* the entry price appears 1–10 s later; more UI states; refund path if no price arrives. · (c) A Worker/server action fetches the price with the service key. *Bad:* adds a secret-holding money path in the Worker. |
| D6 | **Settlement after a long price outage** | ★ **(a) Settle at the first valid post-expiry price whenever it arrives.** *Good:* never uses a stale price; no extra code. *Bad:* after a 10 min outage, the settle price is 10 min late. · (b) Auto-void (refund premium + fee) if no valid price within `expires_at + 2 min`. *Good:* fair to users. *Bad:* one more status, ledger kind and RPC. · (c) Admin manual void. *Good:* rare and controlled. *Bad:* needs ops attention. |
| D7 | **Tie (settle = entry)** | ★ (a) Draw: refund the premium, keep the fee. · (b) Loss. *Bad:* feels unfair. · (c) Full refund including the fee. *Good:* friendliest. *Bad:* fee-free retries. |
| D8 | **Realtime transport** | ★ (a) postgres_changes (current). *Good:* no extra triggers. *Bad:* per-subscriber RLS on a single thread doesn't scale far. · (b) Trigger → `realtime.broadcast_changes` to private `user:<uid>` channels. *Good:* scales; Supabase recommends it. *Bad:* `realtime.messages` policies and topic-prefix matching. |
| D9 | **Withdrawal gating** | ★ (a) KYC approved + AAL2 if MFA is enrolled (implemented, matches UI D7-A). · (b) No gating (virtual funds only). *Good:* frictionless. *Bad:* the KYC flow loses its purpose. |

---

## 14. Supabase usage estimate (10 users, terminals open 4 h/day)

**Assumptions:**
- Per user per terminal-hour: 15 options, 4 spot orders (2 market, 2 limit, of which ¾ fill and ¼ are canceled), 2 forex round trips, 1 transfer.
- Users partly overlap, so the feed is "hot" 8 h/day. For the other 16 h only resting limit orders exist, which triggers 1 tick per minute.
- 1.5 open tabs per user on average.

**Activity per day (×10 users × 4 h):** 600 options, 160 spot orders, 80 forex round trips, 40 transfers.

**New DB rows per day:**

| Source | Math | Rows/day |
|---|---|---|
| options_positions | 600 | 600 |
| ledger (options) | 600 × (premium + fee + settle) | 1,800 |
| orders (spot + forex) | 160 + 80 | 240 |
| ledger (spot) | 80 market × 2 + 60 filled limits × ~3 + 20 canceled × 2 | ~380 |
| forex_positions + ledger | 80 + 80 × 3 | 320 |
| transfers + ledger | 40 + 80 | 120 |
| **App total** | | **≈ 3,500/day** (~105 k/month, ~1.3 M/year) |
| cron.job_run_details | 2 jobs × 8,640 | 17,280/day (purged daily, holds ~35 k) |
| net._http_response | one per Edge call (below) | ~3,840/day (6 h TTL) |
| price_snapshots | ~12 markets × 3,840 upserts | ~46 k HOT updates/day, 12 live rows |

Storage: about 300–400 B per ledger row including 4 indexes, so ~1.3 M rows/year ≈ **0.4–0.5 GB/year**. That approaches the Free plan's 500 MB database limit in about a year; plan to archive the ledger or move to Pro.

**Edge Function invocations:**
- Hot: 8 h × 360 ticks/h = 2,880/day.
- Limit-orders-only: 16 h × 60/h = 960/day.
- Total 3,840/day ≈ **115 k/month**.
- Worst case, always hot at 10 s: 8,640/day ≈ **259 k/month**.
- Both are under the Free quota of **500,000** (Pro 2 M) (<https://supabase.com/docs/guides/functions/pricing>). A 5 s interval that is always hot would be ~518 k/month and exceed Free. This is why demand gating and the 10 s interval were chosen.

**Realtime messages** (one per change per subscribed client; <https://supabase.com/docs/guides/platform/manage-your-usage/realtime-messages>):

| Event | Messages per event | Per day |
|---|---|---|
| Option: open (2 wallet + 1 position) + settle (1 position + ~0.5 wallet) | ~4.5 | 2,700 |
| Spot order (insert, wallet/holding, fill update) | ~5.5 | 880 |
| Forex round trip | ~6 | 480 |
| Transfer | 2 | 80 |
| **Subtotal × 1.5 tabs** | | **≈ 6,200/day ≈ 186 k/month** |

That is under the Free quota of **2 M/month**; peak connections are about 15, under 200 (<https://supabase.com/docs/guides/realtime/pricing>).

Counter-example showing why `price_snapshots` is **not** published: 12 markets × 6/min × 240 min × 10 users × 1.5 tabs ≈ 259 k/day ≈ **7.8 M/month**, which would exceed the quota on its own. Display prices come from the market-data store instead.

**DB load:** the settle and match cron runs (8,640/day each) are index-only checks when nothing is due. RPCs total about 1,000/day, and reads are a few thousand PostgREST requests per day. All of this is negligible on the smallest compute.

---

## 15. Deployment checklist (Phase 2; not done here)
1. Review and apply the migration (`supabase db push`), then run `get_advisors`.
2. Insert the first admin: `insert into public.user_roles (user_id, role) values ('<uuid>', 'admin');`.
3. Enable the Custom Access Token hook → `public.custom_access_token_hook`.
4. Vault: `project_url`, `price_ingest_secret`. Edge secret: `PRICE_INGEST_SECRET`. Deploy `price-ingest --no-verify-jwt`.
5. Uncomment and run the three `cron.schedule` calls at the bottom of the migration (price tick, settle/match, history cleanup).
6. Admin sets real `cycle_config` values and enables cycles. The market-data agent fills in `markets.price_source/source_symbol`.

---

## 16. Slice 4 Part A as shipped (Spot market orders, server price feed)

Migration `supabase/migrations/20261026130512_spot_market_orders.sql`, applied through the Management API. Tests: `supabase/tests/slice4_part_a.sh` (temporary users as real roles, deleted afterwards).

### 16.1 What exists

| Object | Notes |
|---|---|
| `markets.qty_decimals`, `markets.min_notional_cents` | From Vision `exchangeInfo` (2026-10-26). Every `LOT_SIZE.stepSize` is a power of ten and equals `minQty`, so a decimal count replaces `qty_step`/`min_qty`. Minimum order value 5.00, except DOGE and PEPE at 1.00 (`NOTIONAL.minNotional`, `applyMinToMarket: true`). |
| `spot_config` (one row) | `fee_bps = 10` (0.1%, an assumption: the Spot fee was not captured) and `max_price_age_s = 60` (CHECK 1..60). Authenticated read. |
| `price_snapshots` | One row per market: `bid`, `ask` (CHECK > 0, not NaN, `ask >= bid`), `fetched_at` (source time, clamped to `now()`), `source` (`vision`/`kucoin`). Authenticated read. Not in Realtime. |
| `system_state` (one row) | `price_demand_until`. No policy, not readable over the API. |
| `spot_holdings` | `(user_id, asset)`, `available_qty numeric(38,18)`, `cost_basis_cents` (average cost, buy fees included). Balance-write guard trigger. Own rows only. |
| `orders` | Filled Spot market orders: `side`, `qty`, `price` (the ask or bid used), `price_at`, `price_source`, `notional_cents`, `fee_bps`, `fee_cents`, `realized_pnl_cents` (sells), `client_request_id` (unique per user). Own rows only. |
| `public.spot_market_order(p_market_id, p_side, p_qty text, p_client_request_id)` | **No price parameter.** Locks the Spot wallet, then the holding. Reads the snapshot itself after the idempotency check. |
| `public.request_price_feed()` | Heartbeat: opens the demand window for 5 minutes (writes at most about once a minute). |
| `public.ingest_prices(jsonb)` | `service_role` only. Re-validates every entry; forward-only upsert. |
| `private.parse_decimal`, `format_amount`, `lock_holding`, `holding_apply`, `touch_price_demand`, `price_tick` | No client EXECUTE. |
| pg_cron `aureonx-price-tick` (`10 seconds`) | `private.price_tick()`: a no-op read unless the demand window is open; then one `net.http_post` to `price-ingest` (pinned `x-region: eu-west-1`) with the shared header secret from Vault. |
| pg_cron `aureonx-cron-history-cleanup` (daily 03:17 UTC) | Deletes `cron.job_run_details` older than 2 days. |
| Edge Function `price-ingest` (`supabase/functions/price-ingest/index.ts`) | Deployed with `verify_jwt: false`; it checks `x-aureonx-cron-secret` itself. The owner set the secret and Vault entries on 2026-10-26. Vision `ticker/24hr` for all markets in one GET, then KuCoin `allTickers` for any market Vision did not quote validly. 2.5 s per attempt, 2 attempts, full-jitter backoff, a failed provider skipped for 30 s per isolate. Drops any quote older than 30 s or more than 5 s ahead (C6). Logs one JSON line per run, never a key. |

### 16.1a Feed verified end to end (2026-10-26, after the owner set the secrets)

A temporary user called `request_price_feed()`; the next ticks posted to `price-ingest` every 10 s. Every `net._http_response` was 200, and each run logged `vision: ok:20, accepted 20, rejected 0, ignored 0` in 1.2 to 1.5 s. All 20 markets had a Vision snapshot about 5 s old; none used KuCoin and none was missing. Each run booted a fresh isolate (about 23 ms), so the 30 s provider skip and the 60 s markets cache rarely carry over between ticks; the 2-attempt cap per provider per tick is what bounds upstream calls.

Fix migration `20261026165953_ingest_prices_ignored_count.sql` replaces `ingest_prices` only: it returns `{accepted, rejected, ignored}`, where `ignored` counts valid prices the forward-only upsert did not write. Tested in a rolled-back transaction: a newer price `accepted: 1`, then an older one `ignored: 1`, and the newer price stayed.

### 16.2 Money rules

- Buy fills at the snapshot **ask**, sell at the **bid**. A snapshot older than `max_price_age_s` (60 s) or missing gives `PRICE_STALE`, and nothing is written.
- **Cent rounding goes against the user** (the platform never creates money): buy cost = `ceil(qty × ask × 100)`, sell proceeds = `floor(qty × bid × 100)`, fee = `ceil(order value in cents × fee_bps / 10000)`. The minimum order value is checked on the unrounded `qty × price × 100`.
- Bills rows per order, all through `wallet_apply`: a buy writes `spot_buy` ("Bought 0.001 BTC at 50,000.10", asset leg `+qty`) and `fee` ("Trading fee"); a sell writes `spot_sell` ("Sold 0.0096 BTC at 50,000.00", asset leg `−qty`, PnL = proceeds − removed basis) and `fee` (PnL = −fee). The price in the memo uses the market's `price_decimals`.
- A sell removes `floor(basis × qty / available_qty)` of cost basis; realized PnL = proceeds − fee − removed basis.
- Error codes the UI maps: `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `MARKET_NOT_FOUND`, `MARKET_DISABLED`, `INVALID_NUMBER`, `INVALID_QTY` (DETAIL `max_decimals=N` or `too_large`), `WALLET_NOT_FOUND`, `PRICE_STALE`, `BELOW_MIN_NOTIONAL` (DETAIL `min_cents=N`), `INSUFFICIENT_FUNDS`, `INSUFFICIENT_ASSET`, `IDEMPOTENCY_CONFLICT`.
- The RPC returns the `orders` row. Its numeric fields arrive as JSON numbers, so the UI must not read `qty`/`price` from it; it refetches with `::text` casts (C4).

### 16.3 Where this differs from the Phase 1 design (owner's slice 4 brief wins)

| Phase 1 design | Slice 4 |
|---|---|
| Fills need a snapshot ≤ 15 s old (C6, `markets.max_price_age_s`) | 60 s, in `spot_config` (brief). With a 10 s tick the age is normally 0 to 11 s |
| One `price` per snapshot | `bid` and `ask` (buy at the ask, sell at the bid) |
| `markets.taker_fee_bps` per market | One `spot_config.fee_bps` row |
| `qty_step`, `min_qty`, `price_tick` | `qty_decimals` (step is a power of ten on every market) and `min_notional_cents` |
| `place_spot_order` (market + limit, optional `p_quote_cents`) | `spot_market_order` (market only, quantity only) |
| `orders` with type/status/limit/hold columns; `spot_holdings.held_qty` | Left out until Part C adds limit orders |
| Ingest jump filter (`max_jump_bps`) | Left out; the multi-source median check (O12) lands in slice 5 |
| `spot_holdings`, `orders` in Realtime | Not published. Every order changes the Spot wallet, which is published, so screens refetch on that event (the Bills pattern) |
| Slice 2: "the DB stores no display copy" | Spot rows carry a readable `memo` (brief), like "Balance adjustment" |

### 16.4 Part C design (limit orders; not built)

1. `orders` gains `type` (`market`/`limit`), `status` (`open`/`filled`/`canceled`), `limit_price`, `hold_cents`, `hold_qty`, `filled_at`, `canceled_at`; `spot_holdings` gains `held_qty`.
2. Placing a buy limit reserves `ceil(qty × limit × 100) + fee` through `wallet_apply` (`order_hold`: available −, held +); a sell limit moves `qty` from `available_qty` to `held_qty`.
3. A limit that is marketable against a fresh snapshot at placement fills at once at the snapshot ask/bid, never worse than the limit.
4. `match_open_orders` (service role, called by `price-ingest` after each ingest and by a pg_cron safety net) claims open orders `FOR UPDATE SKIP LOCKED`.
5. A buy fills when a fresh ask ≤ limit, a sell when a fresh bid ≥ limit, and only on a snapshot with `fetched_at >= created_at` (no look-back).
6. Fills happen **at the limit price**, so the reservation is exact: held − cost − fee, nothing refunded.
7. Every fill is a guarded `open → filled` transition, then wallet lock, then holding lock (§1.4); only the winner of the transition moves money.
8. `cancel_order` is a guarded `open → canceled` that releases the hold (`order_release`); a second cancel returns the canceled row.
9. Resting orders keep the price feed alive at about one tick per minute (`price_tick` demand), and never fail on a stale price; they wait.
10. Same idempotency key rules as market orders; the cap on open orders per user is decided in Part C.
