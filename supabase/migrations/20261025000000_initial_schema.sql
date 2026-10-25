-- =============================================================================
-- PROPOSED — NOT APPLIED. Review in Phase 1 sign-off.
-- =============================================================================
-- AureonX initial schema (simulated multi-asset trading; demo funds only).
-- Design doc: docs/data-model.md  (read it first; this file implements it).
--
-- Conventions (enforced throughout):
--   * Cash (USDT, treated 1:1 as USD) is BIGINT minor units (cents). Columns end in _cents.
--   * Asset quantities and prices are NUMERIC(38,18), passed to/from RPCs as TEXT
--     (decimal strings) so JS never parses them as floats.
--   * Rates are INTEGER basis points (_bps). No float/double anywhere in money paths.
--   * Every balance change goes through private.wallet_apply / private.holding_apply,
--     which write a ledger row in the same transaction. A trigger blocks any other
--     UPDATE of balance rows.
--   * Lock order (deadlock avoidance), everywhere:
--       1. the one existing domain row (order / position / request) via a guarded
--          status transition, or a batch of them via FOR UPDATE SKIP LOCKED;
--       2. wallets, ascending by id (private.lock_wallets);
--       3. spot_holdings, ascending by (user_id, asset);
--       4. profiles (KYC only).
--   * All SECURITY DEFINER functions: set search_path = '' and fully qualified names.
--   * Errors: RAISE EXCEPTION '<CODE>' (SQLSTATE P0001). Codes listed in the doc.
-- Target: Supabase Postgres 15+/17 (pg_cron 1.6.4, pg_net).
-- No explicit BEGIN/COMMIT: the Supabase CLI applies each migration file atomically.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Extensions and schemas
-- -----------------------------------------------------------------------------
create extension if not exists pg_net with schema extensions;   -- creates schema "net"
create extension if not exists pg_cron with schema pg_catalog;  -- creates schema "cron"

-- Non-exposed schema for helpers. PostgREST exposes only "public" (and graphql_public),
-- so nothing here is callable over the API.
create schema if not exists private;

-- -----------------------------------------------------------------------------
-- 1. Types
-- -----------------------------------------------------------------------------
create type public.wallet_account   as enum ('capital', 'spot', 'forex', 'options');
create type public.market_kind      as enum ('spot', 'forex');
create type public.order_side       as enum ('buy', 'sell');
create type public.order_type       as enum ('market', 'limit');
create type public.order_status     as enum ('open', 'filled', 'canceled');
create type public.option_direction as enum ('rise', 'fall');
create type public.option_status    as enum ('open', 'settled');
create type public.option_result    as enum ('win', 'loss', 'draw');
create type public.forex_side       as enum ('long', 'short');
create type public.position_status  as enum ('open', 'closed');
create type public.request_status   as enum ('pending', 'approved', 'rejected', 'canceled');
create type public.kyc_status       as enum ('none', 'pending', 'approved', 'rejected');
create type public.app_role         as enum ('admin');
create type public.ledger_kind as enum (
  'transfer_in', 'transfer_out',
  'deposit',
  'withdrawal_hold', 'withdrawal_release', 'withdrawal_paid',
  'admin_credit', 'admin_debit',
  'order_hold', 'order_release',
  'spot_buy', 'spot_sell',
  'forex_margin', 'forex_close',
  'option_premium', 'option_settle',
  'fee'
);

-- -----------------------------------------------------------------------------
-- 2. Tables
-- -----------------------------------------------------------------------------

-- 2.1 profiles (1:1 with auth.users; created by signup trigger)
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  uid         bigint not null unique check (uid between 10000000 and 99999999), -- public 8-digit UID
  email       text,                                   -- mirrored from auth.users by trigger
  nickname    text not null check (char_length(nickname) between 1 and 32),
  phone       text check (phone is null or phone ~ '^\+?[0-9 ()-]{6,20}$'),
  country     text check (country is null or country ~ '^[A-Z]{2}$'),       -- ISO 3166-1 alpha-2
  kyc_status  public.kyc_status not null default 'none',
  created_at  timestamptz not null default now()
);
create index profiles_email_idx on public.profiles (lower(email));

-- 2.2 user_roles (admin membership; managed by SQL/dashboard only)
create table public.user_roles (
  user_id     uuid not null references auth.users (id) on delete cascade,
  role        public.app_role not null,
  granted_at  timestamptz not null default now(),
  granted_by  uuid references auth.users (id) on delete set null,
  primary key (user_id, role)
);

-- 2.3 wallets: one cash (USDT cents) row per user per sub-wallet
create table public.wallets (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles (id) on delete cascade,
  account          public.wallet_account not null,
  currency         text not null default 'USDT' check (currency = 'USDT'),
  available_cents  bigint not null default 0 check (available_cents >= 0),
  held_cents       bigint not null default 0 check (held_cents >= 0),   -- frozen: open buy orders, pending withdrawals
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (user_id, account)
);

-- 2.4 spot_holdings: base-asset quantities held in the Spot sub-wallet
create table public.spot_holdings (
  user_id           uuid not null references public.profiles (id) on delete cascade,
  asset             text not null check (asset ~ '^[A-Z0-9]{2,10}$'),
  available_qty     numeric(38,18) not null default 0 check (available_qty >= 0),
  held_qty          numeric(38,18) not null default 0 check (held_qty >= 0),   -- open sell orders
  cost_basis_cents  bigint not null default 0 check (cost_basis_cents >= 0),  -- for realized PnL (avg cost)
  updated_at        timestamptz not null default now(),
  primary key (user_id, asset)
);

-- 2.5 markets: tradable instruments (spot + forex). Public read.
create table public.markets (
  id                  text primary key check (id ~ '^[A-Z0-9]{2,10}-[A-Z0-9]{2,10}$'), -- 'BTC-USDT', 'XAU-USD'
  kind                public.market_kind not null,
  display_name        text not null,                    -- 'BTC/USDT'
  base_asset          text not null,
  quote_asset         text not null,
  enabled             boolean not null default true,
  options_enabled     boolean not null default false,  -- may be used as an options underlying
  price_source        text not null,                    -- provider key, resolved by the price-ingest Edge Function
  source_symbol       text not null,                    -- provider's symbol for this market
  qty_step            numeric(38,18) check (qty_step > 0),   -- spot only
  min_qty             numeric(38,18) check (min_qty > 0),    -- spot only
  price_tick          numeric(38,18) not null check (price_tick > 0),
  min_notional_cents  bigint not null default 100 check (min_notional_cents > 0),  -- spot notional / forex margin
  taker_fee_bps       integer not null default 0 check (taker_fee_bps between 0 and 1000),
  max_price_age_s     integer not null default 15 check (max_price_age_s between 1 and 60), -- fills + option entry
  max_jump_bps        integer not null default 2000 check (max_jump_bps > 0),  -- ingest sanity band vs last snapshot
  sort_order          integer not null default 0,
  check (kind = 'forex' or (qty_step is not null and min_qty is not null))
);

-- 2.6 price_snapshots: latest server-fetched price per market (one row per market, upserted)
create table public.price_snapshots (
  market_id    text primary key references public.markets (id) on delete cascade,
  price        numeric(38,18) not null
                 check (price > 0 and price <> 'NaN'::numeric and price < 'Infinity'::numeric),
  fetched_at   timestamptz not null,       -- provider/fetch time, clamped to <= now() at ingest
  source       text not null,
  ingested_at  timestamptz not null default now()
);

-- 2.7 cycle_config: options cycles. Rates live here, never in code.
create table public.cycle_config (
  duration_s             integer primary key check (duration_s between 10 and 3600),
  profit_rate_bps        integer not null check (profit_rate_bps between 0 and 100000), -- 8500 = +85% of premium on win
  fee_bps                integer not null default 0 check (fee_bps between 0 and 1000),  -- charged on premium at open
  min_premium_cents      bigint not null check (min_premium_cents > 0),
  max_premium_cents      bigint not null,
  premium_presets_cents  bigint[] not null default '{}',
  enabled                boolean not null default false,
  updated_at             timestamptz not null default now(),
  updated_by             uuid references auth.users (id) on delete set null,
  check (max_premium_cents >= min_premium_cents)
);

-- 2.8 system_state: singleton for the price-feed demand signal
create table public.system_state (
  id                  boolean primary key default true check (id),
  price_demand_until  timestamptz not null default '-infinity'
);

-- 2.9 payment_networks: coin -> network options for deposit/withdraw requests. Public read.
create table public.payment_networks (
  asset               text not null check (asset ~ '^[A-Z0-9]{2,10}$'),
  network             text not null check (network ~ '^[A-Z0-9_-]{2,20}$'),
  usd_pegged          boolean not null default false,  -- true: deposit credit defaults to amount x 100 cents
  deposit_enabled     boolean not null default true,
  withdraw_enabled    boolean not null default true,
  min_deposit         numeric(38,18) not null default 0 check (min_deposit >= 0),
  min_withdraw_cents  bigint not null default 1000 check (min_withdraw_cents > 0),
  withdraw_fee_cents  bigint not null default 0 check (withdraw_fee_cents >= 0),
  sort_order          integer not null default 0,
  primary key (asset, network)
);

-- 2.10 transfers between a user's own sub-wallets
create table public.transfers (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profiles (id) on delete cascade,
  from_wallet_id     uuid not null references public.wallets (id),
  to_wallet_id       uuid not null references public.wallets (id),
  from_account       public.wallet_account not null,
  to_account         public.wallet_account not null,
  amount_cents       bigint not null check (amount_cents > 0),
  client_request_id  uuid not null,
  created_at         timestamptz not null default now(),
  unique (user_id, client_request_id),
  check (from_wallet_id <> to_wallet_id)
);
create index transfers_user_created_idx on public.transfers (user_id, created_at desc);

-- 2.11 orders: spot and forex, all-or-nothing fills (no partial fills in v1)
create table public.orders (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.profiles (id) on delete cascade,
  wallet_id           uuid not null references public.wallets (id),
  market_id           text not null references public.markets (id),
  market_kind         public.market_kind not null,
  side                public.order_side not null,           -- forex: buy = long, sell = short
  type                public.order_type not null,
  status              public.order_status not null,
  qty                 numeric(38,18) check (qty > 0),       -- spot only (base units)
  margin_cents        bigint check (margin_cents > 0),      -- forex only (USDT at risk)
  limit_price         numeric(38,18) check (limit_price > 0),
  hold_cents          bigint not null default 0 check (hold_cents >= 0),        -- cash frozen while open
  hold_qty            numeric(38,18) not null default 0 check (hold_qty >= 0),  -- asset frozen while open
  fill_price          numeric(38,18),
  fill_price_at       timestamptz,                           -- snapshot time of the price used
  quote_cents         bigint,                                -- filled notional (spot) / margin (forex)
  fee_cents           bigint not null default 0 check (fee_cents >= 0),
  realized_pnl_cents  bigint,                                -- spot sells only
  client_request_id   uuid not null,
  created_at          timestamptz not null default now(),
  filled_at           timestamptz,
  canceled_at         timestamptz,
  unique (user_id, client_request_id),
  check ((market_kind = 'spot'  and qty is not null and margin_cents is null)
      or (market_kind = 'forex' and margin_cents is not null and qty is null)),
  check (type = 'market' or limit_price is not null),
  check (type = 'limit' or status <> 'open')
);
create index orders_user_created_idx on public.orders (user_id, created_at desc);
create index orders_open_idx on public.orders (market_id, side, limit_price) where status = 'open';

-- 2.12 forex_positions: opened by a filled forex order; closed by close_forex_position
create table public.forex_positions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles (id) on delete cascade,
  wallet_id       uuid not null references public.wallets (id),
  market_id       text not null references public.markets (id),
  order_id        uuid not null unique references public.orders (id),
  side            public.forex_side not null,
  margin_cents    bigint not null check (margin_cents > 0),
  open_fee_cents  bigint not null check (open_fee_cents >= 0),
  entry_price     numeric(38,18) not null check (entry_price > 0),
  entry_price_at  timestamptz not null,
  opened_at       timestamptz not null default now(),
  status          public.position_status not null default 'open',
  exit_price      numeric(38,18),
  exit_price_at   timestamptz,
  payout_cents    bigint check (payout_cents >= 0),
  pnl_cents       bigint,
  closed_at       timestamptz,
  check (status = 'open' or (exit_price is not null and payout_cents is not null and closed_at is not null))
);
create index forex_positions_user_idx on public.forex_positions (user_id, opened_at desc);
create index forex_positions_open_idx on public.forex_positions (user_id) where status = 'open';

-- 2.13 options_positions
create table public.options_positions (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profiles (id) on delete cascade,
  wallet_id          uuid not null references public.wallets (id),
  market_id          text not null references public.markets (id),
  direction          public.option_direction not null,
  duration_s         integer not null,
  premium_cents      bigint not null check (premium_cents > 0),
  fee_cents          bigint not null check (fee_cents >= 0),
  profit_rate_bps    integer not null check (profit_rate_bps >= 0),  -- snapshot of cycle_config at open
  entry_price        numeric(38,18) not null check (entry_price > 0),
  entry_price_at     timestamptz not null,
  created_at         timestamptz not null,                          -- now() inside open_option
  expires_at         timestamptz not null,                          -- created_at + duration_s, server-side
  status             public.option_status not null default 'open',
  result             public.option_result,
  settle_price       numeric(38,18),
  settle_price_at    timestamptz,
  payout_cents       bigint check (payout_cents >= 0),
  pnl_cents          bigint,
  settled_at         timestamptz,
  settled_by         text check (settled_by in ('cron', 'read')),
  client_request_id  uuid not null,
  unique (user_id, client_request_id),
  check (expires_at = created_at + duration_s * interval '1 second'),
  check ((status = 'open' and result is null and settle_price is null and payout_cents is null)
      or (status = 'settled' and result is not null and settle_price is not null
          and settle_price_at >= expires_at and payout_cents is not null and settled_at is not null))
);
create index options_open_due_idx on public.options_positions (expires_at) where status = 'open';
create index options_user_created_idx on public.options_positions (user_id, created_at desc);

-- 2.14 deposits (simulated: no chain interaction; admin approval credits demo funds)
create table public.deposits (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profiles (id) on delete cascade,
  wallet_id          uuid not null references public.wallets (id),   -- always the capital wallet
  asset              text not null,
  network            text not null,
  amount             numeric(38,18) not null check (amount > 0),     -- coin units as entered by the user
  tx_ref             text check (tx_ref is null or char_length(tx_ref) <= 128), -- free-text, unverified
  credit_cents       bigint check (credit_cents > 0),                -- set by admin on approval
  status             public.request_status not null default 'pending'
                       check (status in ('pending', 'approved', 'rejected')),
  client_request_id  uuid not null,
  reviewed_by        uuid references auth.users (id) on delete set null,
  reviewed_at        timestamptz,
  review_note        text,
  created_at         timestamptz not null default now(),
  unique (user_id, client_request_id),
  foreign key (asset, network) references public.payment_networks (asset, network),
  check (status <> 'approved' or credit_cents is not null)
);
create index deposits_pending_idx on public.deposits (created_at) where status = 'pending';
create index deposits_user_idx on public.deposits (user_id, created_at desc);

-- 2.15 withdrawals (simulated: approval removes demo funds; nothing is sent)
create table public.withdrawals (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profiles (id) on delete cascade,
  wallet_id          uuid not null references public.wallets (id),   -- always the capital wallet
  asset              text not null,
  network            text not null,
  address            text not null check (char_length(address) between 10 and 128 and address !~ '\s'),
  amount_cents       bigint not null check (amount_cents > 0),
  fee_cents          bigint not null check (fee_cents >= 0),
  status             public.request_status not null default 'pending',
  client_request_id  uuid not null,
  reviewed_by        uuid references auth.users (id) on delete set null,
  reviewed_at        timestamptz,
  review_note        text,
  created_at         timestamptz not null default now(),
  unique (user_id, client_request_id),
  foreign key (asset, network) references public.payment_networks (asset, network)
);
create index withdrawals_pending_idx on public.withdrawals (created_at) where status = 'pending';
create index withdrawals_user_idx on public.withdrawals (user_id, created_at desc);

-- 2.16 kyc_submissions (files live in private Storage bucket "kyc" under "<uid>/...")
create table public.kyc_submissions (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profiles (id) on delete cascade,
  first_name         text not null check (char_length(first_name) between 1 and 64),
  last_name          text not null check (char_length(last_name) between 1 and 64),
  date_of_birth      date not null,
  country            text not null check (country ~ '^[A-Z]{2}$'),
  address            jsonb,
  document_type      text not null check (document_type in ('passport', 'id_card', 'driver_license')),
  doc_front_path     text not null,
  doc_back_path      text,
  selfie_path        text not null,
  status             public.request_status not null default 'pending'
                       check (status in ('pending', 'approved', 'rejected')),
  client_request_id  uuid not null,
  reviewed_by        uuid references auth.users (id) on delete set null,
  reviewed_at        timestamptz,
  review_note        text,
  created_at         timestamptz not null default now(),
  unique (user_id, client_request_id)
);
create unique index kyc_one_pending_idx on public.kyc_submissions (user_id) where status = 'pending';
create index kyc_pending_idx on public.kyc_submissions (created_at) where status = 'pending';

-- 2.17 ledger ("Bills"): one row per change to a wallets row (+ the asset leg of spot fills)
create table public.ledger (
  id                   bigint generated always as identity primary key,
  user_id              uuid not null references public.profiles (id) on delete cascade,
  wallet_id            uuid not null references public.wallets (id),
  account              public.wallet_account not null,
  kind                 public.ledger_kind not null,
  delta_cents          bigint not null default 0,      -- change to available_cents
  held_delta_cents     bigint not null default 0,      -- change to held_cents
  balance_after_cents  bigint not null check (balance_after_cents >= 0),
  held_after_cents     bigint not null check (held_after_cents >= 0),
  pnl_cents            bigint not null default 0,      -- realized PnL recognized by this row (profit chart)
  asset                text,                           -- spot fills: base asset
  asset_delta          numeric(38,18),                 -- spot fills: +qty buy / -qty sell
  ref_type             text not null check (ref_type in ('transfer', 'order', 'forex_position',
                         'options_position', 'deposit', 'withdrawal', 'admin_adjustment')),
  ref_id               uuid not null,
  actor_id             uuid references auth.users (id) on delete set null,  -- admin for admin actions
  memo                 text,
  created_at           timestamptz not null default now(),
  check (delta_cents <> 0 or held_delta_cents <> 0 or pnl_cents <> 0 or asset_delta is not null),
  check ((asset is null) = (asset_delta is null))
);
create index ledger_user_created_idx on public.ledger (user_id, created_at desc, id desc);
create index ledger_wallet_idx on public.ledger (wallet_id, id);
create index ledger_ref_idx on public.ledger (ref_type, ref_id);
create index ledger_user_pnl_idx on public.ledger (user_id, created_at) include (pnl_cents) where pnl_cents <> 0;

-- 2.18 admin_audit_log: one row per admin RPC call; also the idempotency key for admin_adjust_balance
create table public.admin_audit_log (
  id                 uuid primary key default gen_random_uuid(),
  admin_id           uuid not null references auth.users (id),
  action             text not null,
  target_user_id     uuid references auth.users (id) on delete set null,
  target_id          uuid,
  payload            jsonb not null default '{}',
  client_request_id  uuid unique,
  created_at         timestamptz not null default now()
);
create index admin_audit_created_idx on public.admin_audit_log (created_at desc);

-- 2.19 favorites (UI market list stars; not money)
create table public.favorites (
  user_id     uuid not null references public.profiles (id) on delete cascade,
  market_id   text not null references public.markets (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, market_id)
);

-- -----------------------------------------------------------------------------
-- 3. Private helpers
-- -----------------------------------------------------------------------------

-- 3.1 Admin check. SECURITY DEFINER: runs as the table owner, which bypasses RLS on
-- user_roles, so policies that call it cannot recurse. Never FORCE RLS on user_roles.
create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles r
    where r.user_id = (select auth.uid()) and r.role = 'admin'
  );
$$;

-- 3.2 Strict decimal parser for TEXT inputs (rejects NaN, Infinity, exponents, negatives).
create or replace function private.parse_decimal(p_text text)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_text is null or p_text !~ '^[0-9]{1,20}(\.[0-9]{1,18})?$' then
    raise exception 'INVALID_NUMBER';
  end if;
  return p_text::numeric;
end;
$$;

-- 3.3 Lock wallets in ascending id order (the only way wallets are locked).
create or replace function private.lock_wallets(p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from public.wallets where id = any (p_ids) order by id for update;
end;
$$;

-- 3.4 Guard: wallets / spot_holdings balance rows may only be updated by the helpers below.
create or replace function private.guard_balance_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(current_setting('aureonx.balance_write', true), '') <> 'on' then
    raise exception 'DIRECT_BALANCE_WRITE_FORBIDDEN' using detail = tg_table_name;
  end if;
  return new;
end;
$$;

-- 3.5 THE cash mutation primitive. Caller must already hold the wallet lock.
-- Writes exactly one ledger row per call, in the caller's transaction.
create or replace function private.wallet_apply(
  p_wallet_id    uuid,
  p_delta_cents  bigint,
  p_held_delta   bigint,
  p_kind         public.ledger_kind,
  p_ref_type     text,
  p_ref_id       uuid,
  p_pnl_cents    bigint  default 0,
  p_asset        text    default null,
  p_asset_delta  numeric default null,
  p_actor_id     uuid    default null,
  p_memo         text    default null
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_w  public.wallets;
  v_id bigint;
begin
  select * into v_w from public.wallets where id = p_wallet_id for update;  -- re-entrant
  if not found then
    raise exception 'WALLET_NOT_FOUND';
  end if;
  if v_w.available_cents + p_delta_cents < 0 then
    raise exception 'INSUFFICIENT_FUNDS'
      using detail = format('available=%s required=%s', v_w.available_cents, -p_delta_cents);
  end if;
  if v_w.held_cents + p_held_delta < 0 then
    raise exception 'INVARIANT_HELD_NEGATIVE' using detail = p_wallet_id::text;
  end if;

  if p_delta_cents <> 0 or p_held_delta <> 0 then
    perform set_config('aureonx.balance_write', 'on', true);
    update public.wallets
       set available_cents = available_cents + p_delta_cents,
           held_cents      = held_cents + p_held_delta,
           updated_at      = now()
     where id = p_wallet_id
    returning * into v_w;
    perform set_config('aureonx.balance_write', 'off', true);
  end if;

  insert into public.ledger (user_id, wallet_id, account, kind, delta_cents, held_delta_cents,
                             balance_after_cents, held_after_cents, pnl_cents, asset, asset_delta,
                             ref_type, ref_id, actor_id, memo)
  values (v_w.user_id, v_w.id, v_w.account, p_kind, p_delta_cents, p_held_delta,
          v_w.available_cents, v_w.held_cents, p_pnl_cents, p_asset, p_asset_delta,
          p_ref_type, p_ref_id, p_actor_id, p_memo)
  returning id into v_id;
  return v_id;
end;
$$;

-- 3.6 Ensure + lock a spot holding row.
create or replace function private.lock_holding(p_user_id uuid, p_asset text)
returns public.spot_holdings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_h public.spot_holdings;
begin
  insert into public.spot_holdings (user_id, asset) values (p_user_id, p_asset)
  on conflict do nothing;
  select * into v_h from public.spot_holdings
   where user_id = p_user_id and asset = p_asset for update;
  return v_h;
end;
$$;

-- 3.7 Asset mutation primitive. Caller must hold the spot wallet lock then the holding lock.
-- The asset leg is recorded on the matching ledger row (asset / asset_delta) by the caller.
create or replace function private.holding_apply(
  p_user_id     uuid,
  p_asset       text,
  p_avail_delta numeric,
  p_held_delta  numeric,
  p_cost_delta  bigint
)
returns public.spot_holdings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_h public.spot_holdings;
begin
  select * into v_h from public.spot_holdings
   where user_id = p_user_id and asset = p_asset for update;
  if not found then
    raise exception 'HOLDING_NOT_FOUND';
  end if;
  if v_h.available_qty + p_avail_delta < 0 then
    raise exception 'INSUFFICIENT_ASSET'
      using detail = format('available=%s required=%s', v_h.available_qty, -p_avail_delta);
  end if;
  if v_h.held_qty + p_held_delta < 0 or v_h.cost_basis_cents + p_cost_delta < 0 then
    raise exception 'INVARIANT_HOLDING_NEGATIVE';
  end if;
  perform set_config('aureonx.balance_write', 'on', true);
  update public.spot_holdings
     set available_qty    = available_qty + p_avail_delta,
         held_qty         = held_qty + p_held_delta,
         cost_basis_cents = cost_basis_cents + p_cost_delta,
         updated_at       = now()
   where user_id = p_user_id and asset = p_asset
  returning * into v_h;
  perform set_config('aureonx.balance_write', 'off', true);
  return v_h;
end;
$$;

-- 3.8 Fresh price or NULLs. Never synthesizes a price.
create or replace function private.fresh_price(
  p_market_id text,
  p_max_age_s integer,
  out price numeric,
  out fetched_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  select s.price, s.fetched_at
    into price, fetched_at
    from public.price_snapshots s
   where s.market_id = p_market_id
     and s.price > 0
     and s.price <> 'NaN'::numeric
     and s.fetched_at > now() - make_interval(secs => p_max_age_s)
     and s.fetched_at <= now();
end;
$$;

-- 3.9 Demand signal for the price feed (written at most ~once per minute).
create or replace function private.touch_price_demand()
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_until timestamptz;
begin
  update public.system_state
     set price_demand_until = now() + interval '5 minutes'
   where id and price_demand_until < now() + interval '4 minutes';
  select price_demand_until into v_until from public.system_state where id;
  return v_until;
end;
$$;

-- 3.10 Spot fill. Caller holds: order row (if resting), spot wallet lock, holding lock.
-- p_from_hold = true for resting limit orders (funds/asset already frozen on the order).
create or replace function private.apply_spot_fill(
  p_order     public.orders,
  p_price     numeric,
  p_price_at  timestamptz,
  p_from_hold boolean
)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_m            public.markets;
  v_h            public.spot_holdings;
  v_gross        bigint;
  v_fee          bigint;
  v_cost_removed bigint := 0;
  v_total_qty    numeric;
  v_o            public.orders;
begin
  select * into v_m from public.markets where id = p_order.market_id;

  if p_order.side = 'buy' then
    v_gross := ceil(p_order.qty * p_price * 100)::bigint;                       -- round against the user
    v_fee   := case when p_from_hold then p_order.fee_cents                     -- fee frozen at placement
                    else ceil(v_gross * v_m.taker_fee_bps / 10000.0)::bigint end;
    if p_from_hold and p_order.hold_cents <> v_gross + v_fee then
      raise exception 'INVARIANT_HOLD_MISMATCH' using detail = p_order.id::text;
    end if;
    perform private.wallet_apply(p_order.wallet_id,
      case when p_from_hold then 0 else -v_gross end,
      case when p_from_hold then -v_gross else 0 end,
      'spot_buy', 'order', p_order.id, 0, v_m.base_asset, p_order.qty);
    if v_fee > 0 then
      perform private.wallet_apply(p_order.wallet_id,
        case when p_from_hold then 0 else -v_fee end,
        case when p_from_hold then -v_fee else 0 end,
        'fee', 'order', p_order.id);
    end if;
    -- buy fee is capitalized into cost basis; it is realized when the asset is sold
    perform private.holding_apply(p_order.user_id, v_m.base_asset, p_order.qty, 0, v_gross + v_fee);
  else
    select * into v_h from public.spot_holdings
     where user_id = p_order.user_id and asset = v_m.base_asset;
    v_gross := floor(p_order.qty * p_price * 100)::bigint;                      -- round against the user
    v_fee   := ceil(v_gross * v_m.taker_fee_bps / 10000.0)::bigint;
    v_total_qty := v_h.available_qty + v_h.held_qty;
    if v_total_qty > 0 then
      v_cost_removed := floor(v_h.cost_basis_cents * p_order.qty / v_total_qty)::bigint;
    end if;
    perform private.holding_apply(p_order.user_id, v_m.base_asset,
      case when p_from_hold then 0 else -p_order.qty end,
      case when p_from_hold then -p_order.qty else 0 end,
      -v_cost_removed);
    perform private.wallet_apply(p_order.wallet_id, v_gross, 0, 'spot_sell', 'order', p_order.id,
      v_gross - v_cost_removed, v_m.base_asset, -p_order.qty);
    if v_fee > 0 then
      perform private.wallet_apply(p_order.wallet_id, -v_fee, 0, 'fee', 'order', p_order.id, -v_fee);
    end if;
  end if;

  update public.orders
     set status             = 'filled',
         fill_price         = p_price,
         fill_price_at      = p_price_at,
         quote_cents        = v_gross,
         fee_cents          = v_fee,
         realized_pnl_cents = case when side = 'sell' then v_gross - v_fee - v_cost_removed end,
         filled_at          = coalesce(filled_at, now())
   where id = p_order.id
  returning * into v_o;
  return v_o;
end;
$$;

-- 3.11 Forex fill: opens a forex_positions row. Caller holds order row (if resting) + forex wallet lock.
create or replace function private.apply_forex_fill(
  p_order     public.orders,
  p_price     numeric,
  p_price_at  timestamptz,
  p_from_hold boolean
)
returns public.forex_positions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_m   public.markets;
  v_fee bigint;
  v_pos public.forex_positions;
begin
  select * into v_m from public.markets where id = p_order.market_id;
  v_fee := case when p_from_hold then p_order.fee_cents
                else ceil(p_order.margin_cents * v_m.taker_fee_bps / 10000.0)::bigint end;
  if p_from_hold and p_order.hold_cents <> p_order.margin_cents + v_fee then
    raise exception 'INVARIANT_HOLD_MISMATCH' using detail = p_order.id::text;
  end if;

  insert into public.forex_positions (user_id, wallet_id, market_id, order_id, side, margin_cents,
                                      open_fee_cents, entry_price, entry_price_at)
  values (p_order.user_id, p_order.wallet_id, p_order.market_id, p_order.id,
          case when p_order.side = 'buy' then 'long'::public.forex_side else 'short'::public.forex_side end,
          p_order.margin_cents, v_fee, p_price, p_price_at)
  returning * into v_pos;

  perform private.wallet_apply(p_order.wallet_id,
    case when p_from_hold then 0 else -p_order.margin_cents end,
    case when p_from_hold then -p_order.margin_cents else 0 end,
    'forex_margin', 'forex_position', v_pos.id);
  if v_fee > 0 then
    perform private.wallet_apply(p_order.wallet_id,
      case when p_from_hold then 0 else -v_fee end,
      case when p_from_hold then -v_fee else 0 end,
      'fee', 'forex_position', v_pos.id);
  end if;

  update public.orders
     set status = 'filled', fill_price = p_price, fill_price_at = p_price_at,
         quote_cents = p_order.margin_cents, fee_cents = v_fee,
         filled_at = coalesce(filled_at, now())
   where id = p_order.id;
  return v_pos;
end;
$$;

-- 3.12 Options settlement core (shared by cron and settle-on-read).
-- Idempotent: claims with SKIP LOCKED, then a guarded open->settled transition per row;
-- only the winner of the transition credits. Positions without a valid price stay open.
create or replace function private.settle_options(p_user_id uuid, p_limit integer, p_settled_by text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids     uuid[];
  v_wallets uuid[];
  r         record;
  v_result  public.option_result;
  v_payout  bigint;
  v_settled integer := 0;
  v_pending integer;
begin
  with c as (
    select p.id
      from public.options_positions p
      join public.price_snapshots s on s.market_id = p.market_id
     where p.status = 'open'
       and p.expires_at <= now()
       and (p_user_id is null or p.user_id = p_user_id)
       and s.fetched_at >= p.expires_at                     -- price observed at/after expiry
       and s.fetched_at >  now() - interval '60 seconds'    -- never older than 60 s
       and s.fetched_at <= now()
       and s.price > 0 and s.price <> 'NaN'::numeric
     order by p.id
     limit p_limit
       for update of p skip locked
  )
  select array_agg(id order by id) into v_ids from c;

  if v_ids is not null then
    select array_agg(distinct wallet_id) into v_wallets
      from public.options_positions where id = any (v_ids);
    perform private.lock_wallets(v_wallets);

    for r in
      select p.id, p.wallet_id, p.direction, p.entry_price, p.premium_cents, p.fee_cents,
             p.profit_rate_bps, s.price, s.fetched_at
        from public.options_positions p
        join public.price_snapshots s on s.market_id = p.market_id
       where p.id = any (v_ids)
       order by p.id
    loop
      if r.price = r.entry_price then
        v_result := 'draw';  v_payout := r.premium_cents;               -- premium refunded, fee kept
      elsif (r.direction = 'rise') = (r.price > r.entry_price) then
        v_result := 'win';   v_payout := r.premium_cents + (r.premium_cents * r.profit_rate_bps) / 10000;
      else
        v_result := 'loss';  v_payout := 0;
      end if;

      update public.options_positions
         set status = 'settled', result = v_result,
             settle_price = r.price, settle_price_at = r.fetched_at,
             payout_cents = v_payout,
             pnl_cents = v_payout - r.premium_cents - r.fee_cents,
             settled_at = now(), settled_by = p_settled_by
       where id = r.id and status = 'open';
      if not found then
        continue;                                                         -- lost the race: no credit
      end if;

      perform private.wallet_apply(r.wallet_id, v_payout, 0, 'option_settle', 'options_position', r.id,
                                   v_payout - r.premium_cents - r.fee_cents);
      v_settled := v_settled + 1;
    end loop;
  end if;

  select count(*) into v_pending
    from public.options_positions
   where status = 'open' and expires_at <= now()
     and (p_user_id is null or user_id = p_user_id);

  return jsonb_build_object('settled', v_settled, 'pending', v_pending);
end;
$$;

-- 3.13 Price tick: called by pg_cron every 10 s. Fires the price-ingest Edge Function only
-- when something needs prices. Secrets come from Vault (never stored in this migration).
create or replace function private.price_tick()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hot    boolean;
  v_orders boolean;
  v_url    text;
  v_secret text;
begin
  select exists (select 1 from public.options_positions where status = 'open')
      or (select price_demand_until > now() from public.system_state where id)
    into v_hot;
  select exists (select 1 from public.orders where status = 'open') into v_orders;

  -- hot: every tick (10 s). Only resting limit orders: about once a minute.
  if not (coalesce(v_hot, false) or (v_orders and extract(second from now()) < 10)) then
    return;
  end if;

  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'price_ingest_secret';
  if v_url is null or v_secret is null then
    raise log 'aureonx price_tick: vault secrets project_url / price_ingest_secret missing';
    return;
  end if;

  perform net.http_post(
    url                  := v_url || '/functions/v1/price-ingest',
    headers              := jsonb_build_object('Content-Type', 'application/json',
                                               'x-aureonx-cron-secret', v_secret),
    body                 := jsonb_build_object('tick_at', now()),
    timeout_milliseconds := 8000
  );
end;
$$;

-- 3.14 Signup: profile + 4 wallets. Keep minimal: any error here fails the signup
-- ("Database error saving new user"), which is preferable to a user without wallets.
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   bigint;
  v_tries integer := 0;
begin
  loop
    v_uid := 10000000 + floor(random() * 90000000)::bigint;
    begin
      insert into public.profiles (id, uid, email, nickname)
      values (new.id, v_uid, new.email,
              left(coalesce(nullif(trim(new.raw_user_meta_data ->> 'nickname'), ''),
                            'User' || right(v_uid::text, 4)), 32));
      exit;
    exception when unique_violation then
      v_tries := v_tries + 1;
      if v_tries >= 10 then
        raise;
      end if;
    end;
  end loop;

  insert into public.wallets (user_id, account)
  values (new.id, 'capital'), (new.id, 'spot'), (new.id, 'forex'), (new.id, 'options');
  return new;
end;
$$;

create or replace function private.handle_user_email_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles set email = new.email where id = new.id;
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Triggers
-- -----------------------------------------------------------------------------
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row when (old.email is distinct from new.email)
  execute function private.handle_user_email_change();

create trigger wallets_guard_balance
  before update on public.wallets
  for each row execute function private.guard_balance_write();

create trigger spot_holdings_guard_balance
  before update on public.spot_holdings
  for each row execute function private.guard_balance_write();

-- -----------------------------------------------------------------------------
-- 5. Public RPCs — user (authenticated)
-- -----------------------------------------------------------------------------

-- 5.1 server_time: for the options countdown offset
create or replace function public.server_time()
returns timestamptz
language sql
stable
security invoker
set search_path = ''
as $$ select now(); $$;

-- 5.2 update_profile
create or replace function public.update_profile(p_nickname text, p_phone text, p_country text)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_p   public.profiles;
begin
  if v_uid is null then raise exception 'UNAUTHENTICATED'; end if;
  update public.profiles
     set nickname = coalesce(nullif(trim(p_nickname), ''), nickname),
         phone    = nullif(trim(p_phone), ''),
         country  = nullif(upper(trim(p_country)), '')
   where id = v_uid
  returning * into v_p;
  if not found then raise exception 'PROFILE_NOT_FOUND'; end if;
  return v_p;
end;
$$;

-- 5.3 toggle_favorite
create or replace function public.toggle_favorite(p_market_id text)
returns boolean   -- true = now a favorite
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'UNAUTHENTICATED'; end if;
  delete from public.favorites where user_id = v_uid and market_id = p_market_id;
  if found then return false; end if;
  if not exists (select 1 from public.markets where id = p_market_id) then
    raise exception 'MARKET_NOT_FOUND';
  end if;
  insert into public.favorites (user_id, market_id) values (v_uid, p_market_id)
  on conflict do nothing;
  return true;
end;
$$;

-- 5.4 request_price_feed: terminal mount (and every ~4 min while visible)
create or replace function public.request_price_feed()
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED'; end if;
  return private.touch_price_demand();
end;
$$;

-- 5.5 transfer_between_wallets
create or replace function public.transfer_between_wallets(
  p_from              public.wallet_account,
  p_to                public.wallet_account,
  p_amount_cents      bigint,
  p_client_request_id uuid
)
returns public.transfers
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_from uuid;
  v_to   uuid;
  v_t    public.transfers;
begin
  if v_uid is null then raise exception 'UNAUTHENTICATED'; end if;
  if p_client_request_id is null or p_from is null or p_to is null then
    raise exception 'INVALID_ARGUMENT';
  end if;
  if p_from = p_to then raise exception 'SAME_WALLET'; end if;
  if p_amount_cents is null or p_amount_cents <= 0 then raise exception 'INVALID_AMOUNT'; end if;

  select id into v_from from public.wallets where user_id = v_uid and account = p_from;
  select id into v_to   from public.wallets where user_id = v_uid and account = p_to;
  if v_from is null or v_to is null then raise exception 'WALLET_NOT_FOUND'; end if;

  perform private.lock_wallets(array[v_from, v_to]);

  select * into v_t from public.transfers
   where user_id = v_uid and client_request_id = p_client_request_id;
  if found then
    if v_t.from_wallet_id <> v_from or v_t.to_wallet_id <> v_to or v_t.amount_cents <> p_amount_cents then
      raise exception 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_t;
  end if;

  insert into public.transfers (user_id, from_wallet_id, to_wallet_id, from_account, to_account,
                                amount_cents, client_request_id)
  values (v_uid, v_from, v_to, p_from, p_to, p_amount_cents, p_client_request_id)
  returning * into v_t;

  perform private.wallet_apply(v_from, -p_amount_cents, 0, 'transfer_out', 'transfer', v_t.id);
  perform private.wallet_apply(v_to,    p_amount_cents, 0, 'transfer_in',  'transfer', v_t.id);
  return v_t;
end;
$$;

-- 5.6 place_spot_order
-- Market: fills now at a fresh server snapshot (PRICE_STALE otherwise).
-- Limit: fills now at the snapshot if marketable, else rests with funds/asset frozen.
-- Market buy may pass p_quote_cents instead of p_qty (spend up to this much incl. fee).
create or replace function public.place_spot_order(
  p_market_id         text,
  p_side              public.order_side,
  p_type              public.order_type,
  p_qty               text,
  p_limit_price       text,
  p_client_request_id uuid,
  p_quote_cents       bigint default null
)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid        uuid := auth.uid();
  v_m          public.markets;
  v_wallet     uuid;
  v_qty        numeric;
  v_limit      numeric;
  v_price      numeric;
  v_price_at   timestamptz;
  v_marketable boolean;
  v_notional   bigint;
  v_fee        bigint := 0;
  v_hold       bigint := 0;
  v_o          public.orders;
begin
  if v_uid is null then raise exception 'UNAUTHENTICATED'; end if;
  if p_client_request_id is null or p_side is null or p_type is null then
    raise exception 'INVALID_ARGUMENT';
  end if;

  select * into v_m from public.markets where id = p_market_id;
  if not found or v_m.kind <> 'spot' then raise exception 'MARKET_NOT_FOUND'; end if;
  if not v_m.enabled then raise exception 'MARKET_DISABLED'; end if;

  if p_type = 'limit' then
    v_limit := private.parse_decimal(p_limit_price);
    if v_limit <= 0 or mod(v_limit, v_m.price_tick) <> 0 then raise exception 'INVALID_PRICE'; end if;
  elsif p_limit_price is not null then
    raise exception 'INVALID_ARGUMENT' using detail = 'limit_price is only for limit orders';
  end if;
  if p_quote_cents is not null and not (p_type = 'market' and p_side = 'buy' and p_qty is null) then
    raise exception 'INVALID_ARGUMENT' using detail = 'quote_cents only for market buys without qty';
  end if;

  select id into v_wallet from public.wallets where user_id = v_uid and account = 'spot';
  perform private.lock_wallets(array[v_wallet]);
  perform private.lock_holding(v_uid, v_m.base_asset);

  select * into v_o from public.orders where user_id = v_uid and client_request_id = p_client_request_id;
  if found then
    if v_o.market_id <> p_market_id or v_o.side <> p_side or v_o.type <> p_type then
      raise exception 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_o;
  end if;

  select f.price, f.fetched_at into v_price, v_price_at
    from private.fresh_price(p_market_id, v_m.max_price_age_s) f;
  if p_type = 'market' and v_price is null then raise exception 'PRICE_STALE'; end if;

  if p_quote_cents is not null then
    if p_quote_cents <= 0 then raise exception 'INVALID_AMOUNT'; end if;
    v_qty := floor(p_quote_cents / (v_price * 100 * (1 + v_m.taker_fee_bps / 10000.0)) / v_m.qty_step)
             * v_m.qty_step;
  else
    v_qty := private.parse_decimal(p_qty);
  end if;
  if v_qty < v_m.min_qty or mod(v_qty, v_m.qty_step) <> 0 then raise exception 'INVALID_QTY'; end if;

  v_marketable := v_price is not null
              and (p_type = 'market'
                   or (p_side = 'buy'  and v_price <= v_limit)
                   or (p_side = 'sell' and v_price >= v_limit));

  v_notional := ceil(v_qty * case when v_marketable then v_price else v_limit end * 100)::bigint;
  if v_notional < v_m.min_notional_cents then raise exception 'BELOW_MIN_NOTIONAL'; end if;

  if v_marketable then
    insert into public.orders (user_id, wallet_id, market_id, market_kind, side, type, status, qty,
                               limit_price, client_request_id, filled_at)
    values (v_uid, v_wallet, p_market_id, 'spot', p_side, p_type, 'filled', v_qty,
            v_limit, p_client_request_id, now())
    returning * into v_o;
    return private.apply_spot_fill(v_o, v_price, v_price_at, false);
  end if;

  -- resting limit order: freeze funds (buy) or asset (sell) at the limit price
  if p_side = 'buy' then
    v_fee  := ceil(v_notional * v_m.taker_fee_bps / 10000.0)::bigint;
    v_hold := v_notional + v_fee;
  end if;
  insert into public.orders (user_id, wallet_id, market_id, market_kind, side, type, status, qty,
                             limit_price, hold_cents, hold_qty, fee_cents, client_request_id)
  values (v_uid, v_wallet, p_market_id, 'spot', p_side, 'limit', 'open', v_qty, v_limit,
          v_hold, case when p_side = 'sell' then v_qty else 0 end, v_fee, p_client_request_id)
  returning * into v_o;

  if p_side = 'buy' then
    perform private.wallet_apply(v_wallet, -v_hold, v_hold, 'order_hold', 'order', v_o.id);
  else
    perform private.holding_apply(v_uid, v_m.base_asset, -v_qty, v_qty, 0);
  end if;
  return v_o;
end;
$$;

-- 5.7 place_forex_order (buy = long, sell = short; amount is USDT margin in cents)
create or replace function public.place_forex_order(
  p_market_id         text,
  p_side              public.order_side,
  p_type              public.order_type,
  p_margin_cents      bigint,
  p_limit_price       text,
  p_client_request_id uuid
)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid        uuid := auth.uid();
  v_m          public.markets;
  v_wallet     uuid;
  v_limit      numeric;
  v_price      numeric;
  v_price_at   timestamptz;
  v_marketable boolean;
  v_fee        bigint;
  v_o          public.orders;
begin
  if v_uid is null then raise exception 'UNAUTHENTICATED'; end if;
  if p_client_request_id is null or p_side is null or p_type is null then
    raise exception 'INVALID_ARGUMENT';
  end if;

  select * into v_m from public.markets where id = p_market_id;
  if not found or v_m.kind <> 'forex' then raise exception 'MARKET_NOT_FOUND'; end if;
  if not v_m.enabled then raise exception 'MARKET_DISABLED'; end if;
  if p_margin_cents is null or p_margin_cents <= 0 then raise exception 'INVALID_AMOUNT'; end if;
  if p_margin_cents < v_m.min_notional_cents then raise exception 'BELOW_MIN_NOTIONAL'; end if;

  if p_type = 'limit' then
    v_limit := private.parse_decimal(p_limit_price);
    if v_limit <= 0 or mod(v_limit, v_m.price_tick) <> 0 then raise exception 'INVALID_PRICE'; end if;
  elsif p_limit_price is not null then
    raise exception 'INVALID_ARGUMENT' using detail = 'limit_price is only for limit orders';
  end if;

  select id into v_wallet from public.wallets where user_id = v_uid and account = 'forex';
  perform private.lock_wallets(array[v_wallet]);

  select * into v_o from public.orders where user_id = v_uid and client_request_id = p_client_request_id;
  if found then
    if v_o.market_id <> p_market_id or v_o.side <> p_side or v_o.type <> p_type
       or v_o.margin_cents <> p_margin_cents then
      raise exception 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_o;
  end if;

  select f.price, f.fetched_at into v_price, v_price_at
    from private.fresh_price(p_market_id, v_m.max_price_age_s) f;
  if p_type = 'market' and v_price is null then raise exception 'PRICE_STALE'; end if;

  v_marketable := v_price is not null
              and (p_type = 'market'
                   or (p_side = 'buy'  and v_price <= v_limit)
                   or (p_side = 'sell' and v_price >= v_limit));

  if v_marketable then
    insert into public.orders (user_id, wallet_id, market_id, market_kind, side, type, status,
                               margin_cents, limit_price, client_request_id, filled_at)
    values (v_uid, v_wallet, p_market_id, 'forex', p_side, p_type, 'filled',
            p_margin_cents, v_limit, p_client_request_id, now())
    returning * into v_o;
    perform private.apply_forex_fill(v_o, v_price, v_price_at, false);
    select * into v_o from public.orders where id = v_o.id;
    return v_o;
  end if;

  v_fee := ceil(p_margin_cents * v_m.taker_fee_bps / 10000.0)::bigint;
  insert into public.orders (user_id, wallet_id, market_id, market_kind, side, type, status,
                             margin_cents, limit_price, hold_cents, fee_cents, client_request_id)
  values (v_uid, v_wallet, p_market_id, 'forex', p_side, 'limit', 'open',
          p_margin_cents, v_limit, p_margin_cents + v_fee, v_fee, p_client_request_id)
  returning * into v_o;
  perform private.wallet_apply(v_wallet, -(p_margin_cents + v_fee), p_margin_cents + v_fee,
                               'order_hold', 'order', v_o.id);
  return v_o;
end;
$$;

-- 5.8 cancel_order (idempotent: re-cancel returns the canceled row)
create or replace function public.cancel_order(p_order_id uuid)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_o   public.orders;
  v_m   public.markets;
begin
  if v_uid is null then raise exception 'UNAUTHENTICATED'; end if;

  update public.orders
     set status = 'canceled', canceled_at = now()
   where id = p_order_id and user_id = v_uid and status = 'open'
  returning * into v_o;
  if not found then
    select * into v_o from public.orders where id = p_order_id and user_id = v_uid;
    if not found then raise exception 'ORDER_NOT_FOUND'; end if;
    if v_o.status = 'canceled' then return v_o; end if;
    raise exception 'ORDER_NOT_OPEN';
  end if;

  perform private.lock_wallets(array[v_o.wallet_id]);
  if v_o.hold_cents > 0 then
    perform private.wallet_apply(v_o.wallet_id, v_o.hold_cents, -v_o.hold_cents,
                                 'order_release', 'order', v_o.id);
  end if;
  if v_o.hold_qty > 0 then
    select * into v_m from public.markets where id = v_o.market_id;
    perform private.lock_holding(v_uid, v_m.base_asset);
    perform private.holding_apply(v_uid, v_m.base_asset, v_o.hold_qty, -v_o.hold_qty, 0);
  end if;
  return v_o;
end;
$$;

-- 5.9 close_forex_position (at a fresh server price; idempotent)
create or replace function public.close_forex_position(p_position_id uuid)
returns public.forex_positions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := auth.uid();
  v_pos      public.forex_positions;
  v_m        public.markets;
  v_price    numeric;
  v_price_at timestamptz;
  v_pnl      bigint;
  v_payout   bigint;
begin
  if v_uid is null then raise exception 'UNAUTHENTICATED'; end if;
  select * into v_pos from public.forex_positions where id = p_position_id and user_id = v_uid;
  if not found then raise exception 'POSITION_NOT_FOUND'; end if;
  if v_pos.status = 'closed' then return v_pos; end if;

  select * into v_m from public.markets where id = v_pos.market_id;
  select f.price, f.fetched_at into v_price, v_price_at
    from private.fresh_price(v_pos.market_id, v_m.max_price_age_s) f;
  if v_price is null then raise exception 'PRICE_STALE'; end if;

  -- percentage-return model, no leverage: PnL = margin x signed return; loss capped at margin
  v_pnl := floor(v_pos.margin_cents
                 * case when v_pos.side = 'long' then (v_price - v_pos.entry_price)
                        else (v_pos.entry_price - v_price) end
                 / v_pos.entry_price)::bigint;
  v_payout := greatest(v_pos.margin_cents + v_pnl, 0);

  update public.forex_positions
     set status = 'closed', exit_price = v_price, exit_price_at = v_price_at,
         payout_cents = v_payout,
         pnl_cents = v_payout - margin_cents - open_fee_cents,
         closed_at = now()
   where id = p_position_id and status = 'open'
  returning * into v_pos;
  if not found then
    select * into v_pos from public.forex_positions where id = p_position_id;
    return v_pos;                                   -- closed concurrently; no second credit
  end if;

  perform private.lock_wallets(array[v_pos.wallet_id]);
  perform private.wallet_apply(v_pos.wallet_id, v_payout, 0, 'forex_close', 'forex_position',
                               v_pos.id, v_pos.pnl_cents);
  return v_pos;
end;
$$;

-- 5.10 open_option
create or replace function public.open_option(
  p_market_id         text,
  p_direction         public.option_direction,
  p_duration_s        integer,
  p_premium_cents     bigint,
  p_client_request_id uuid
)
returns public.options_positions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := auth.uid();
  v_wallet   uuid;
  v_m        public.markets;
  v_cfg      public.cycle_config;
  v_price    numeric;
  v_price_at timestamptz;
  v_fee      bigint;
  v_pos      public.options_positions;
begin
  if v_uid is null then raise exception 'UNAUTHENTICATED'; end if;
  if p_client_request_id is null or p_direction is null then raise exception 'INVALID_ARGUMENT'; end if;

  select id into v_wallet from public.wallets where user_id = v_uid and account = 'options';
  perform private.lock_wallets(array[v_wallet]);

  select * into v_pos from public.options_positions
   where user_id = v_uid and client_request_id = p_client_request_id;
  if found then
    if v_pos.market_id <> p_market_id or v_pos.direction <> p_direction
       or v_pos.duration_s <> p_duration_s or v_pos.premium_cents <> p_premium_cents then
      raise exception 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_pos;
  end if;

  select * into v_m from public.markets where id = p_market_id;
  if not found then raise exception 'MARKET_NOT_FOUND'; end if;
  if not (v_m.enabled and v_m.options_enabled) then raise exception 'MARKET_DISABLED'; end if;

  select * into v_cfg from public.cycle_config where duration_s = p_duration_s;
  if not found then raise exception 'CYCLE_NOT_FOUND'; end if;
  if not v_cfg.enabled then raise exception 'CYCLE_DISABLED'; end if;
  if p_premium_cents is null
     or p_premium_cents < v_cfg.min_premium_cents or p_premium_cents > v_cfg.max_premium_cents then
    raise exception 'PREMIUM_OUT_OF_RANGE';
  end if;

  select f.price, f.fetched_at into v_price, v_price_at
    from private.fresh_price(p_market_id, v_m.max_price_age_s) f;
  if v_price is null then raise exception 'PRICE_STALE'; end if;

  v_fee := ceil(p_premium_cents * v_cfg.fee_bps / 10000.0)::bigint;

  insert into public.options_positions (user_id, wallet_id, market_id, direction, duration_s,
                                        premium_cents, fee_cents, profit_rate_bps, entry_price,
                                        entry_price_at, created_at, expires_at, client_request_id)
  values (v_uid, v_wallet, p_market_id, p_direction, p_duration_s, p_premium_cents, v_fee,
          v_cfg.profit_rate_bps, v_price, v_price_at, now(),
          now() + p_duration_s * interval '1 second', p_client_request_id)
  returning * into v_pos;

  perform private.wallet_apply(v_wallet, -p_premium_cents, 0, 'option_premium', 'options_position', v_pos.id);
  if v_fee > 0 then
    perform private.wallet_apply(v_wallet, -v_fee, 0, 'fee', 'options_position', v_pos.id);
  end if;
  return v_pos;
end;
$$;

-- 5.11 settle_my_expired_options: settle-on-read backup. Same core, same price rules.
-- Takes NO price argument by design.
create or replace function public.settle_my_expired_options()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_res jsonb;
begin
  if v_uid is null then raise exception 'UNAUTHENTICATED'; end if;
  v_res := private.settle_options(v_uid, 50, 'read');
  if (v_res ->> 'pending')::integer > 0 then
    perform private.touch_price_demand();            -- make sure the next cron tick fetches
  end if;
  return v_res;
end;
$$;

-- 5.12 request_deposit (simulated; no address is issued)
create or replace function public.request_deposit(
  p_asset             text,
  p_network           text,
  p_amount            text,
  p_client_request_id uuid,
  p_tx_ref            text default null
)
returns public.deposits
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_net    public.payment_networks;
  v_amount numeric;
  v_wallet uuid;
  v_d      public.deposits;
begin
  if v_uid is null then raise exception 'UNAUTHENTICATED'; end if;
  if p_client_request_id is null then raise exception 'INVALID_ARGUMENT'; end if;

  select * into v_d from public.deposits where user_id = v_uid and client_request_id = p_client_request_id;
  if found then return v_d; end if;

  select * into v_net from public.payment_networks where asset = p_asset and network = p_network;
  if not found or not v_net.deposit_enabled then raise exception 'NETWORK_DISABLED'; end if;
  v_amount := private.parse_decimal(p_amount);
  if v_amount <= 0 or v_amount < v_net.min_deposit then raise exception 'BELOW_MINIMUM'; end if;
  if (select count(*) from public.deposits where user_id = v_uid and status = 'pending') >= 5 then
    raise exception 'TOO_MANY_PENDING';
  end if;

  select id into v_wallet from public.wallets where user_id = v_uid and account = 'capital';
  begin
    insert into public.deposits (user_id, wallet_id, asset, network, amount, tx_ref, client_request_id)
    values (v_uid, v_wallet, p_asset, p_network, v_amount, nullif(trim(p_tx_ref), ''), p_client_request_id)
    returning * into v_d;
  exception when unique_violation then
    select * into v_d from public.deposits where user_id = v_uid and client_request_id = p_client_request_id;
  end;
  return v_d;
end;
$$;

-- 5.13 request_withdrawal: freezes amount + fee in the capital wallet
create or replace function public.request_withdrawal(
  p_asset             text,
  p_network           text,
  p_address           text,
  p_amount_cents      bigint,
  p_client_request_id uuid
)
returns public.withdrawals
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_net    public.payment_networks;
  v_wallet uuid;
  v_total  bigint;
  v_w      public.withdrawals;
begin
  if v_uid is null then raise exception 'UNAUTHENTICATED'; end if;
  if p_client_request_id is null then raise exception 'INVALID_ARGUMENT'; end if;
  if p_amount_cents is null or p_amount_cents <= 0 then raise exception 'INVALID_AMOUNT'; end if;

  if (select kyc_status from public.profiles where id = v_uid) <> 'approved' then
    raise exception 'KYC_REQUIRED';
  end if;
  -- users with a verified MFA factor must be at AAL2 for withdrawals
  if exists (select 1 from auth.mfa_factors f where f.user_id = v_uid and f.status = 'verified')
     and coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'MFA_REQUIRED';
  end if;

  select * into v_net from public.payment_networks where asset = p_asset and network = p_network;
  if not found or not v_net.withdraw_enabled then raise exception 'NETWORK_DISABLED'; end if;
  if p_amount_cents < v_net.min_withdraw_cents then raise exception 'BELOW_MINIMUM'; end if;
  if p_address is null or char_length(p_address) not between 10 and 128 or p_address ~ '\s' then
    raise exception 'INVALID_ADDRESS';
  end if;

  select id into v_wallet from public.wallets where user_id = v_uid and account = 'capital';
  perform private.lock_wallets(array[v_wallet]);

  select * into v_w from public.withdrawals where user_id = v_uid and client_request_id = p_client_request_id;
  if found then
    if v_w.amount_cents <> p_amount_cents or v_w.address <> p_address then
      raise exception 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_w;
  end if;

  v_total := p_amount_cents + v_net.withdraw_fee_cents;
  insert into public.withdrawals (user_id, wallet_id, asset, network, address, amount_cents, fee_cents,
                                  client_request_id)
  values (v_uid, v_wallet, p_asset, p_network, p_address, p_amount_cents, v_net.withdraw_fee_cents,
          p_client_request_id)
  returning * into v_w;
  perform private.wallet_apply(v_wallet, -v_total, v_total, 'withdrawal_hold', 'withdrawal', v_w.id);
  return v_w;
end;
$$;

-- 5.14 cancel_withdrawal (user, while pending)
create or replace function public.cancel_withdrawal(p_withdrawal_id uuid)
returns public.withdrawals
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_w   public.withdrawals;
begin
  if v_uid is null then raise exception 'UNAUTHENTICATED'; end if;
  update public.withdrawals set status = 'canceled'
   where id = p_withdrawal_id and user_id = v_uid and status = 'pending'
  returning * into v_w;
  if not found then
    select * into v_w from public.withdrawals where id = p_withdrawal_id and user_id = v_uid;
    if not found then raise exception 'REQUEST_NOT_FOUND'; end if;
    if v_w.status = 'canceled' then return v_w; end if;
    raise exception 'REQUEST_NOT_PENDING';
  end if;
  perform private.lock_wallets(array[v_w.wallet_id]);
  perform private.wallet_apply(v_w.wallet_id, v_w.amount_cents + v_w.fee_cents,
                               -(v_w.amount_cents + v_w.fee_cents), 'withdrawal_release', 'withdrawal', v_w.id);
  return v_w;
end;
$$;

-- 5.15 submit_kyc (files must already be uploaded to kyc/<uid>/...)
create or replace function public.submit_kyc(
  p_first_name        text,
  p_last_name         text,
  p_date_of_birth     date,
  p_country           text,
  p_document_type     text,
  p_doc_front_path    text,
  p_doc_back_path     text,
  p_selfie_path       text,
  p_client_request_id uuid,
  p_address           jsonb default null
)
returns public.kyc_submissions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_status public.kyc_status;
  v_k      public.kyc_submissions;
  v_path   text;
begin
  if v_uid is null then raise exception 'UNAUTHENTICATED'; end if;
  if p_client_request_id is null then raise exception 'INVALID_ARGUMENT'; end if;

  select kyc_status into v_status from public.profiles where id = v_uid for update;  -- serialize per user
  select * into v_k from public.kyc_submissions where user_id = v_uid and client_request_id = p_client_request_id;
  if found then return v_k; end if;
  if v_status = 'pending'  then raise exception 'KYC_ALREADY_PENDING'; end if;
  if v_status = 'approved' then raise exception 'KYC_ALREADY_APPROVED'; end if;
  if p_date_of_birth is null or p_date_of_birth > (current_date - interval '18 years')::date then
    raise exception 'KYC_INVALID_DOB';
  end if;

  foreach v_path in array array_remove(array[p_doc_front_path, p_doc_back_path, p_selfie_path], null) loop
    if split_part(v_path, '/', 1) <> v_uid::text or v_path like '%..%' then
      raise exception 'KYC_PATH_INVALID' using detail = v_path;
    end if;
    if not exists (select 1 from storage.objects o where o.bucket_id = 'kyc' and o.name = v_path) then
      raise exception 'KYC_FILE_MISSING' using detail = v_path;
    end if;
  end loop;
  if p_doc_front_path is null or p_selfie_path is null then raise exception 'KYC_FILE_MISSING'; end if;

  insert into public.kyc_submissions (user_id, first_name, last_name, date_of_birth, country, address,
                                      document_type, doc_front_path, doc_back_path, selfie_path,
                                      client_request_id)
  values (v_uid, trim(p_first_name), trim(p_last_name), p_date_of_birth, upper(p_country), p_address,
          p_document_type, p_doc_front_path, p_doc_back_path, p_selfie_path, p_client_request_id)
  returning * into v_k;
  update public.profiles set kyc_status = 'pending' where id = v_uid;
  return v_k;
end;
$$;

-- 5.16 Read helpers (SECURITY INVOKER: RLS applies)
create or replace function public.get_pnl_series(p_range text)
returns table (bucket timestamptz, pnl_cents bigint, cumulative_cents bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  with cfg as (
    select case p_range when '1D' then interval '1 day'  when '1W' then interval '7 days'
                        when '1M' then interval '1 month' when '6M' then interval '6 months' end as span,
           case p_range when '1D' then 'hour' when '1W' then 'day'
                        when '1M' then 'day'  when '6M' then 'week' end as unit
  ), b as (
    select date_trunc(cfg.unit, l.created_at) as bucket, sum(l.pnl_cents)::bigint as pnl_cents
      from public.ledger l, cfg
     where l.user_id = (select auth.uid())
       and l.pnl_cents <> 0
       and l.created_at >= now() - cfg.span
     group by 1
  )
  select b.bucket, b.pnl_cents, (sum(b.pnl_cents) over (order by b.bucket))::bigint
    from b
   order by b.bucket;
$$;

create or replace function public.get_options_stats(p_since timestamptz default null)
returns table (duration_s integer, trades bigint, wins bigint, losses bigint, draws bigint,
               premium_cents bigint, fee_cents bigint, pnl_cents bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select p.duration_s,
         count(*),
         count(*) filter (where p.result = 'win'),
         count(*) filter (where p.result = 'loss'),
         count(*) filter (where p.result = 'draw'),
         coalesce(sum(p.premium_cents), 0)::bigint,
         coalesce(sum(p.fee_cents), 0)::bigint,
         coalesce(sum(p.pnl_cents), 0)::bigint
    from public.options_positions p
   where p.user_id = (select auth.uid())
     and p.status = 'settled'
     and (p_since is null or p.created_at >= p_since)
   group by p.duration_s
   order by p.duration_s;
$$;

-- -----------------------------------------------------------------------------
-- 6. Public RPCs — admin (authenticated + is_admin() check inside)
-- -----------------------------------------------------------------------------

create or replace function public.admin_review_deposit(
  p_deposit_id   uuid,
  p_approve      boolean,
  p_credit_cents bigint default null,
  p_note         text default null
)
returns public.deposits
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin  uuid := auth.uid();
  v_d      public.deposits;
  v_peg    boolean;
  v_credit bigint;
  v_target public.request_status := case when p_approve then 'approved'::public.request_status
                                         else 'rejected'::public.request_status end;
begin
  if not private.is_admin() then raise exception 'FORBIDDEN'; end if;
  if p_approve is null then raise exception 'INVALID_ARGUMENT'; end if;

  select * into v_d from public.deposits where id = p_deposit_id;
  if not found then raise exception 'REQUEST_NOT_FOUND'; end if;
  if v_d.status = v_target then return v_d; end if;                      -- idempotent repeat
  if v_d.status <> 'pending' then raise exception 'REQUEST_NOT_PENDING'; end if;

  if p_approve then
    select usd_pegged into v_peg from public.payment_networks where asset = v_d.asset and network = v_d.network;
    v_credit := coalesce(p_credit_cents, case when v_peg then floor(v_d.amount * 100)::bigint end);
    if v_credit is null then raise exception 'CREDIT_AMOUNT_REQUIRED'; end if;
    if v_credit <= 0 or v_credit > 100000000000 then raise exception 'INVALID_AMOUNT'; end if;
  elsif coalesce(trim(p_note), '') = '' then
    raise exception 'NOTE_REQUIRED';
  end if;

  update public.deposits
     set status = v_target, credit_cents = v_credit, reviewed_by = v_admin, reviewed_at = now(),
         review_note = p_note
   where id = p_deposit_id and status = 'pending'
  returning * into v_d;
  if not found then raise exception 'REQUEST_NOT_PENDING'; end if;       -- lost a concurrent review

  if p_approve then
    perform private.lock_wallets(array[v_d.wallet_id]);
    perform private.wallet_apply(v_d.wallet_id, v_credit, 0, 'deposit', 'deposit', v_d.id,
                                 0, null, null, v_admin, p_note);
  end if;
  insert into public.admin_audit_log (admin_id, action, target_user_id, target_id, payload)
  values (v_admin, 'review_deposit', v_d.user_id, v_d.id,
          jsonb_build_object('approve', p_approve, 'credit_cents', v_credit, 'note', p_note));
  return v_d;
end;
$$;

create or replace function public.admin_review_withdrawal(
  p_withdrawal_id uuid,
  p_approve       boolean,
  p_note          text default null
)
returns public.withdrawals
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin  uuid := auth.uid();
  v_w      public.withdrawals;
  v_target public.request_status := case when p_approve then 'approved'::public.request_status
                                         else 'rejected'::public.request_status end;
begin
  if not private.is_admin() then raise exception 'FORBIDDEN'; end if;
  if p_approve is null then raise exception 'INVALID_ARGUMENT'; end if;
  if not p_approve and coalesce(trim(p_note), '') = '' then raise exception 'NOTE_REQUIRED'; end if;

  update public.withdrawals
     set status = v_target, reviewed_by = v_admin, reviewed_at = now(), review_note = p_note
   where id = p_withdrawal_id and status = 'pending'
  returning * into v_w;
  if not found then
    select * into v_w from public.withdrawals where id = p_withdrawal_id;
    if not found then raise exception 'REQUEST_NOT_FOUND'; end if;
    if v_w.status = v_target then return v_w; end if;
    raise exception 'REQUEST_NOT_PENDING';
  end if;

  perform private.lock_wallets(array[v_w.wallet_id]);
  if p_approve then
    perform private.wallet_apply(v_w.wallet_id, 0, -v_w.amount_cents, 'withdrawal_paid', 'withdrawal',
                                 v_w.id, 0, null, null, v_admin, p_note);
    if v_w.fee_cents > 0 then
      perform private.wallet_apply(v_w.wallet_id, 0, -v_w.fee_cents, 'fee', 'withdrawal',
                                   v_w.id, 0, null, null, v_admin);
    end if;
  else
    perform private.wallet_apply(v_w.wallet_id, v_w.amount_cents + v_w.fee_cents,
                                 -(v_w.amount_cents + v_w.fee_cents), 'withdrawal_release', 'withdrawal',
                                 v_w.id, 0, null, null, v_admin, p_note);
  end if;
  insert into public.admin_audit_log (admin_id, action, target_user_id, target_id, payload)
  values (v_admin, 'review_withdrawal', v_w.user_id, v_w.id,
          jsonb_build_object('approve', p_approve, 'note', p_note));
  return v_w;
end;
$$;

create or replace function public.admin_adjust_balance(
  p_user_id           uuid,
  p_account           public.wallet_account,
  p_delta_cents       bigint,
  p_reason            text,
  p_client_request_id uuid
)
returns public.admin_audit_log
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin  uuid := auth.uid();
  v_wallet uuid;
  v_a      public.admin_audit_log;
begin
  if not private.is_admin() then raise exception 'FORBIDDEN'; end if;
  if p_client_request_id is null or p_account is null then raise exception 'INVALID_ARGUMENT'; end if;
  if p_delta_cents is null or p_delta_cents = 0 or abs(p_delta_cents) > 100000000000 then
    raise exception 'INVALID_AMOUNT';
  end if;
  if coalesce(char_length(trim(p_reason)), 0) < 3 then raise exception 'NOTE_REQUIRED'; end if;

  select id into v_wallet from public.wallets where user_id = p_user_id and account = p_account;
  if v_wallet is null then raise exception 'WALLET_NOT_FOUND'; end if;
  perform private.lock_wallets(array[v_wallet]);

  select * into v_a from public.admin_audit_log where client_request_id = p_client_request_id;
  if found then
    if v_a.target_id <> v_wallet or (v_a.payload ->> 'delta_cents')::bigint <> p_delta_cents then
      raise exception 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_a;
  end if;

  insert into public.admin_audit_log (admin_id, action, target_user_id, target_id, payload, client_request_id)
  values (v_admin, 'adjust_balance', p_user_id, v_wallet,
          jsonb_build_object('account', p_account, 'delta_cents', p_delta_cents, 'reason', p_reason),
          p_client_request_id)
  returning * into v_a;

  -- a debit can only take available funds (never held); INSUFFICIENT_FUNDS otherwise
  perform private.wallet_apply(v_wallet, p_delta_cents, 0,
                               case when p_delta_cents > 0 then 'admin_credit'::public.ledger_kind
                                    else 'admin_debit'::public.ledger_kind end,
                               'admin_adjustment', v_a.id, 0, null, null, v_admin, p_reason);
  return v_a;
end;
$$;

create or replace function public.admin_review_kyc(
  p_submission_id uuid,
  p_approve       boolean,
  p_note          text default null
)
returns public.kyc_submissions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin  uuid := auth.uid();
  v_k      public.kyc_submissions;
  v_target public.request_status := case when p_approve then 'approved'::public.request_status
                                         else 'rejected'::public.request_status end;
begin
  if not private.is_admin() then raise exception 'FORBIDDEN'; end if;
  if p_approve is null then raise exception 'INVALID_ARGUMENT'; end if;
  if not p_approve and coalesce(trim(p_note), '') = '' then raise exception 'NOTE_REQUIRED'; end if;

  update public.kyc_submissions
     set status = v_target, reviewed_by = v_admin, reviewed_at = now(), review_note = p_note
   where id = p_submission_id and status = 'pending'
  returning * into v_k;
  if not found then
    select * into v_k from public.kyc_submissions where id = p_submission_id;
    if not found then raise exception 'REQUEST_NOT_FOUND'; end if;
    if v_k.status = v_target then return v_k; end if;
    raise exception 'REQUEST_NOT_PENDING';
  end if;

  update public.profiles
     set kyc_status = case when p_approve then 'approved'::public.kyc_status else 'rejected'::public.kyc_status end
   where id = v_k.user_id;
  insert into public.admin_audit_log (admin_id, action, target_user_id, target_id, payload)
  values (v_admin, 'review_kyc', v_k.user_id, v_k.id, jsonb_build_object('approve', p_approve, 'note', p_note));
  return v_k;
end;
$$;

create or replace function public.admin_set_cycle_config(
  p_duration_s            integer,
  p_profit_rate_bps       integer,
  p_fee_bps               integer,
  p_min_premium_cents     bigint,
  p_max_premium_cents     bigint,
  p_premium_presets_cents bigint[],
  p_enabled               boolean
)
returns public.cycle_config
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin uuid := auth.uid();
  v_c     public.cycle_config;
begin
  if not private.is_admin() then raise exception 'FORBIDDEN'; end if;
  if p_duration_s is null or p_duration_s not between 10 and 3600
     or p_profit_rate_bps is null or p_profit_rate_bps not between 0 and 100000
     or p_fee_bps is null or p_fee_bps not between 0 and 1000
     or p_min_premium_cents is null or p_min_premium_cents <= 0
     or p_max_premium_cents is null or p_max_premium_cents < p_min_premium_cents
     or p_enabled is null
     or exists (select 1 from unnest(coalesce(p_premium_presets_cents, '{}')) x
                 where x < p_min_premium_cents or x > p_max_premium_cents) then
    raise exception 'INVALID_ARGUMENT';
  end if;

  insert into public.cycle_config (duration_s, profit_rate_bps, fee_bps, min_premium_cents,
                                   max_premium_cents, premium_presets_cents, enabled, updated_at, updated_by)
  values (p_duration_s, p_profit_rate_bps, p_fee_bps, p_min_premium_cents, p_max_premium_cents,
          coalesce(p_premium_presets_cents, '{}'), p_enabled, now(), v_admin)
  on conflict (duration_s) do update
     set profit_rate_bps = excluded.profit_rate_bps, fee_bps = excluded.fee_bps,
         min_premium_cents = excluded.min_premium_cents, max_premium_cents = excluded.max_premium_cents,
         premium_presets_cents = excluded.premium_presets_cents, enabled = excluded.enabled,
         updated_at = now(), updated_by = v_admin
  returning * into v_c;

  insert into public.admin_audit_log (admin_id, action, payload)
  values (v_admin, 'set_cycle_config', to_jsonb(v_c));
  return v_c;   -- open positions keep the rate snapshotted at open
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. Public RPCs — service_role only (Edge Function / cron)
-- -----------------------------------------------------------------------------

-- 7.1 ingest_prices: [{ "market_id": "BTC-USDT", "price": "67123.45", "source": "...", "ts": "<iso>" }]
-- Price must be a decimal STRING. Invalid / stale / future / out-of-band entries are skipped.
create or replace function public.ingest_prices(p_prices jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  e       jsonb;
  v_m     public.markets;
  v_prev  public.price_snapshots;
  v_price numeric;
  v_ts    timestamptz;
  v_ok    integer := 0;
  v_rej   integer := 0;
begin
  if p_prices is null or jsonb_typeof(p_prices) <> 'array' then raise exception 'INVALID_ARGUMENT'; end if;

  for e in select value from jsonb_array_elements(p_prices) loop
    begin
      select * into v_m from public.markets where id = e ->> 'market_id' and enabled;
      if not found or jsonb_typeof(e -> 'price') <> 'string' then
        v_rej := v_rej + 1; continue;
      end if;
      v_price := private.parse_decimal(e ->> 'price');          -- rejects NaN/Infinity/negatives
      v_ts    := coalesce((e ->> 'ts')::timestamptz, now());
      if v_price <= 0 or v_ts > now() + interval '5 seconds' or v_ts < now() - interval '60 seconds' then
        v_rej := v_rej + 1; continue;
      end if;
      v_ts := least(v_ts, now());

      select * into v_prev from public.price_snapshots where market_id = v_m.id;
      if found and v_prev.fetched_at > now() - interval '5 minutes'
         and abs(v_price - v_prev.price) * 10000 > v_prev.price * v_m.max_jump_bps then
        raise log 'aureonx ingest: % jump rejected (% -> %)', v_m.id, v_prev.price, v_price;
        v_rej := v_rej + 1; continue;
      end if;

      insert into public.price_snapshots (market_id, price, fetched_at, source, ingested_at)
      values (v_m.id, v_price, v_ts, coalesce(e ->> 'source', 'unknown'), now())
      on conflict (market_id) do update
         set price = excluded.price, fetched_at = excluded.fetched_at,
             source = excluded.source, ingested_at = excluded.ingested_at
       where public.price_snapshots.fetched_at < excluded.fetched_at;
      v_ok := v_ok + 1;
    exception
      when raise_exception or invalid_text_representation or invalid_datetime_format
           or datetime_field_overflow or numeric_value_out_of_range then
        v_rej := v_rej + 1;
    end;
  end loop;
  return jsonb_build_object('accepted', v_ok, 'rejected', v_rej);
end;
$$;

-- 7.2 settle_due_options (cron + Edge Function)
create or replace function public.settle_due_options(p_limit integer default 500)
returns jsonb
language sql
security definer
set search_path = ''
as $$ select private.settle_options(null, p_limit, 'cron'); $$;

-- 7.3 match_open_orders: fill resting limit orders whose limit a fresh price (observed after
-- placement) has crossed. Fills at the limit price. Claims with SKIP LOCKED.
create or replace function public.match_open_orders(p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids     uuid[];
  v_wallets uuid[];
  r         record;
  v_o       public.orders;
  v_n       integer := 0;
begin
  with c as (
    select o.id
      from public.orders o
      join public.markets m on m.id = o.market_id
      join public.price_snapshots s on s.market_id = o.market_id
     where o.status = 'open' and o.type = 'limit' and m.enabled
       and s.fetched_at > now() - make_interval(secs => m.max_price_age_s)
       and s.fetched_at >= o.created_at
       and ((o.side = 'buy' and s.price <= o.limit_price) or (o.side = 'sell' and s.price >= o.limit_price))
     order by o.id
     limit p_limit
       for update of o skip locked
  )
  select array_agg(id order by id) into v_ids from c;
  if v_ids is null then return 0; end if;

  select array_agg(distinct wallet_id) into v_wallets from public.orders where id = any (v_ids);
  perform private.lock_wallets(v_wallets);

  insert into public.spot_holdings (user_id, asset)
  select distinct o.user_id, m.base_asset
    from public.orders o join public.markets m on m.id = o.market_id
   where o.id = any (v_ids) and o.market_kind = 'spot'
  on conflict do nothing;
  perform 1
     from public.spot_holdings h
    where (h.user_id, h.asset) in (select o.user_id, m.base_asset
                                     from public.orders o join public.markets m on m.id = o.market_id
                                    where o.id = any (v_ids) and o.market_kind = 'spot')
    order by h.user_id, h.asset
      for update of h;

  for r in
    select o.id, s.fetched_at
      from public.orders o join public.price_snapshots s on s.market_id = o.market_id
     where o.id = any (v_ids)
     order by o.id
  loop
    update public.orders set status = 'filled', filled_at = now()
     where id = r.id and status = 'open'
    returning * into v_o;
    if not found then continue; end if;
    if v_o.market_kind = 'spot' then
      perform private.apply_spot_fill(v_o, v_o.limit_price, r.fetched_at, true);
    else
      perform private.apply_forex_fill(v_o, v_o.limit_price, r.fetched_at, true);
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. Auth hook: copy admin role into the JWT ("user_role" claim) for routing only.
-- Authorization in SQL always uses private.is_admin() (live table read).
-- Enable in Dashboard > Authentication > Hooks > Custom Access Token.
-- -----------------------------------------------------------------------------
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_claims jsonb := event -> 'claims';
  v_admin  boolean;
begin
  select exists (select 1 from public.user_roles r
                  where r.user_id = (event ->> 'user_id')::uuid and r.role = 'admin')
    into v_admin;
  v_claims := jsonb_set(v_claims, '{user_role}',
                        case when v_admin then '"admin"'::jsonb else 'null'::jsonb end);
  return jsonb_set(event, '{claims}', v_claims);
end;
$$;

-- -----------------------------------------------------------------------------
-- 9. Row Level Security
-- -----------------------------------------------------------------------------
alter table public.profiles          enable row level security;
alter table public.user_roles        enable row level security;
alter table public.wallets           enable row level security;
alter table public.spot_holdings     enable row level security;
alter table public.markets           enable row level security;
alter table public.price_snapshots   enable row level security;
alter table public.cycle_config      enable row level security;
alter table public.system_state      enable row level security;
alter table public.payment_networks  enable row level security;
alter table public.transfers         enable row level security;
alter table public.orders            enable row level security;
alter table public.forex_positions   enable row level security;
alter table public.options_positions enable row level security;
alter table public.deposits          enable row level security;
alter table public.withdrawals       enable row level security;
alter table public.kyc_submissions   enable row level security;
alter table public.ledger            enable row level security;
alter table public.admin_audit_log   enable row level security;
alter table public.favorites         enable row level security;

-- Own-or-admin SELECT on user-owned tables. No INSERT/UPDATE/DELETE policies: all writes are RPCs.
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select private.is_admin()));
create policy user_roles_select on public.user_roles for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));
create policy user_roles_auth_hook on public.user_roles for select to supabase_auth_admin
  using (true);
create policy wallets_select on public.wallets for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));
create policy spot_holdings_select on public.spot_holdings for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));
create policy transfers_select on public.transfers for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));
create policy orders_select on public.orders for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));
create policy forex_positions_select on public.forex_positions for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));
create policy options_positions_select on public.options_positions for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));
create policy deposits_select on public.deposits for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));
create policy withdrawals_select on public.withdrawals for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));
create policy kyc_submissions_select on public.kyc_submissions for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));
create policy ledger_select on public.ledger for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));
create policy favorites_select on public.favorites for select to authenticated
  using (user_id = (select auth.uid()));
create policy admin_audit_log_select on public.admin_audit_log for select to authenticated
  using ((select private.is_admin()));
create policy system_state_select on public.system_state for select to authenticated
  using ((select private.is_admin()));

-- Reference data
create policy markets_select on public.markets for select to anon, authenticated using (true);
create policy payment_networks_select on public.payment_networks for select to anon, authenticated using (true);
create policy cycle_config_select on public.cycle_config for select to anon, authenticated using (true);
create policy price_snapshots_select on public.price_snapshots for select to authenticated using (true);

-- -----------------------------------------------------------------------------
-- 10. Grants (defense in depth on top of RLS)
-- -----------------------------------------------------------------------------
-- Supabase default privileges grant ALL on new public tables/functions to anon/authenticated.
-- Remove them; re-grant only SELECT. No client can INSERT/UPDATE/DELETE any table.
revoke all on all tables in schema public from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;

grant select on public.profiles, public.user_roles, public.wallets, public.spot_holdings,
                public.price_snapshots, public.transfers, public.orders, public.forex_positions,
                public.options_positions, public.deposits, public.withdrawals, public.kyc_submissions,
                public.ledger, public.admin_audit_log, public.favorites, public.system_state
  to authenticated;
grant select on public.markets, public.payment_networks, public.cycle_config to anon, authenticated;

-- Functions: nothing is executable by default.
revoke all on all functions in schema public  from public, anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;
alter default privileges for role postgres in schema public  revoke execute on functions from public, anon, authenticated;
alter default privileges for role postgres in schema private revoke execute on functions from public, anon, authenticated;

-- RLS policies call private.is_admin() as the querying role.
grant usage on schema private to authenticated;
grant execute on function private.is_admin() to authenticated;

-- authenticated (user RPCs; admin RPCs re-check is_admin() inside)
grant execute on function public.server_time() to anon, authenticated;
grant execute on function public.update_profile(text, text, text) to authenticated;
grant execute on function public.toggle_favorite(text) to authenticated;
grant execute on function public.request_price_feed() to authenticated;
grant execute on function public.transfer_between_wallets(public.wallet_account, public.wallet_account, bigint, uuid) to authenticated;
grant execute on function public.place_spot_order(text, public.order_side, public.order_type, text, text, uuid, bigint) to authenticated;
grant execute on function public.place_forex_order(text, public.order_side, public.order_type, bigint, text, uuid) to authenticated;
grant execute on function public.cancel_order(uuid) to authenticated;
grant execute on function public.close_forex_position(uuid) to authenticated;
grant execute on function public.open_option(text, public.option_direction, integer, bigint, uuid) to authenticated;
grant execute on function public.settle_my_expired_options() to authenticated;
grant execute on function public.request_deposit(text, text, text, uuid, text) to authenticated;
grant execute on function public.request_withdrawal(text, text, text, bigint, uuid) to authenticated;
grant execute on function public.cancel_withdrawal(uuid) to authenticated;
grant execute on function public.submit_kyc(text, text, date, text, text, text, text, text, uuid, jsonb) to authenticated;
grant execute on function public.get_pnl_series(text) to authenticated;
grant execute on function public.get_options_stats(timestamptz) to authenticated;
grant execute on function public.admin_review_deposit(uuid, boolean, bigint, text) to authenticated;
grant execute on function public.admin_review_withdrawal(uuid, boolean, text) to authenticated;
grant execute on function public.admin_adjust_balance(uuid, public.wallet_account, bigint, text, uuid) to authenticated;
grant execute on function public.admin_review_kyc(uuid, boolean, text) to authenticated;
grant execute on function public.admin_set_cycle_config(integer, integer, integer, bigint, bigint, bigint[], boolean) to authenticated;

-- service_role only
grant execute on function public.ingest_prices(jsonb) to service_role;
grant execute on function public.settle_due_options(integer) to service_role;
grant execute on function public.match_open_orders(integer) to service_role;

-- Auth hook
grant usage on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
grant select on public.user_roles to supabase_auth_admin;
-- Trigger functions on auth.users (EXECUTE is checked at CREATE TRIGGER; granted anyway for clarity)
grant usage on schema private to supabase_auth_admin;
grant execute on function private.handle_new_user() to supabase_auth_admin;
grant execute on function private.handle_user_email_change() to supabase_auth_admin;

-- -----------------------------------------------------------------------------
-- 11. Storage: private KYC bucket, path "<auth.uid()>/<file>"
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('kyc', 'kyc', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do nothing;

create policy kyc_objects_insert_own on storage.objects for insert to authenticated
  with check (bucket_id = 'kyc' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy kyc_objects_select_own_or_admin on storage.objects for select to authenticated
  using (bucket_id = 'kyc'
         and ((storage.foldername(name))[1] = (select auth.uid())::text or (select private.is_admin())));
-- No UPDATE/DELETE policies: uploads are immutable for users (upload with upsert: false).

-- -----------------------------------------------------------------------------
-- 12. Seed data
-- -----------------------------------------------------------------------------
insert into public.system_state (id) values (true);

-- PLACEHOLDER profit rates / fees / limits. Rows are DISABLED until an admin sets real
-- values via admin_set_cycle_config(...). Do not ship these numbers as product decisions.
insert into public.cycle_config (duration_s, profit_rate_bps, fee_bps, min_premium_cents, max_premium_cents,
                                 premium_presets_cents, enabled)
values
  ( 30, 0, 0, 1000, 1000000, '{1000,5000,10000,50000,100000}', false),  -- PLACEHOLDER
  ( 60, 0, 0, 1000, 1000000, '{1000,5000,10000,50000,100000}', false),  -- PLACEHOLDER
  ( 90, 0, 0, 1000, 1000000, '{1000,5000,10000,50000,100000}', false),  -- PLACEHOLDER
  (120, 0, 0, 1000, 1000000, '{1000,5000,10000,50000,100000}', false),  -- PLACEHOLDER
  (300, 0, 0, 1000, 1000000, '{1000,5000,10000,50000,100000}', false);  -- PLACEHOLDER

-- Markets. price_source / source_symbol are PLACEHOLDERS for the market-data agent to fill.
-- Fees are PLACEHOLDERS. Forex/metals are not options underlyings until an intraday source exists.
insert into public.markets (id, kind, display_name, base_asset, quote_asset, options_enabled, price_source,
                            source_symbol, qty_step, min_qty, price_tick, taker_fee_bps, sort_order)
values
  ('BTC-USDT',  'spot', 'BTC/USDT',  'BTC',  'USDT', true, 'crypto_primary', 'TBD', 0.00001, 0.00001, 0.01,    10, 10),
  ('ETH-USDT',  'spot', 'ETH/USDT',  'ETH',  'USDT', true, 'crypto_primary', 'TBD', 0.0001,  0.0001,  0.01,    10, 20),
  ('SOL-USDT',  'spot', 'SOL/USDT',  'SOL',  'USDT', true, 'crypto_primary', 'TBD', 0.001,   0.001,   0.01,    10, 30),
  ('XRP-USDT',  'spot', 'XRP/USDT',  'XRP',  'USDT', true, 'crypto_primary', 'TBD', 0.1,     0.1,     0.0001,  10, 40),
  ('DOGE-USDT', 'spot', 'DOGE/USDT', 'DOGE', 'USDT', true, 'crypto_primary', 'TBD', 1,       1,       0.00001, 10, 50);

insert into public.markets (id, kind, display_name, base_asset, quote_asset, options_enabled, price_source,
                            source_symbol, price_tick, min_notional_cents, taker_fee_bps, sort_order)
values
  ('XAU-USD', 'forex', 'XAU/USD', 'XAU', 'USD', false, 'fx_intraday_tbd', 'TBD', 0.01,    1000, 5, 110),
  ('XAG-USD', 'forex', 'XAG/USD', 'XAG', 'USD', false, 'fx_intraday_tbd', 'TBD', 0.001,   1000, 5, 120),
  ('EUR-USD', 'forex', 'EUR/USD', 'EUR', 'USD', false, 'fx_intraday_tbd', 'TBD', 0.00001, 1000, 5, 130),
  ('AUD-USD', 'forex', 'AUD/USD', 'AUD', 'USD', false, 'fx_intraday_tbd', 'TBD', 0.00001, 1000, 5, 140),
  ('AUD-JPY', 'forex', 'AUD/JPY', 'AUD', 'JPY', false, 'fx_intraday_tbd', 'TBD', 0.001,   1000, 5, 150),
  ('AUD-CAD', 'forex', 'AUD/CAD', 'AUD', 'CAD', false, 'fx_intraday_tbd', 'TBD', 0.00001, 1000, 5, 160),
  ('CAD-JPY', 'forex', 'CAD/JPY', 'CAD', 'JPY', false, 'fx_intraday_tbd', 'TBD', 0.001,   1000, 5, 170);

-- Deposit/withdraw options (simulated). Fees/minimums are PLACEHOLDERS.
insert into public.payment_networks (asset, network, usd_pegged, min_deposit, min_withdraw_cents,
                                     withdraw_fee_cents, sort_order)
values
  ('USDT', 'TRC20', true,  1,      1000, 100, 10),
  ('USDT', 'ERC20', true,  1,      1000, 500, 20),
  ('USDC', 'ERC20', true,  1,      1000, 500, 30),
  ('BTC',  'BTC',   false, 0.0001, 1000, 500, 40),
  ('ETH',  'ERC20', false, 0.001,  1000, 500, 50);

-- -----------------------------------------------------------------------------
-- 13. Realtime: postgres_changes for the owner's rows (RLS is applied per subscriber)
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table
      public.wallets, public.spot_holdings, public.orders, public.forex_positions,
      public.options_positions, public.deposits, public.withdrawals, public.kyc_submissions,
      public.profiles, public.cycle_config;
  end if;
end;
$$;
-- NOT published on purpose: ledger (refetch Bills on wallet change), price_snapshots
-- (every 10 s x markets x viewers would exhaust the message quota), admin_audit_log.

-- -----------------------------------------------------------------------------
-- 14. pg_cron schedules — NOT RUN BY THIS MIGRATION.
-- Prerequisites (run once per environment, by hand, never committed):
--   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
--   select vault.create_secret('<random 32+ byte secret>', 'price_ingest_secret');
--   -- and set the same secret on the Edge Function: supabase secrets set PRICE_INGEST_SECRET=...
--   -- deploy: supabase functions deploy price-ingest --no-verify-jwt  (it checks the header itself)
-- Seconds syntax needs Supabase Postgres >= 15.1.1.61 (pg_cron >= 1.5; Supabase ships 1.6.4).
--
-- select cron.schedule('aureonx-price-tick', '10 seconds', $c$ select private.price_tick(); $c$);
-- select cron.schedule('aureonx-settle',     '10 seconds',
--   $c$ select public.settle_due_options(500); select public.match_open_orders(200); $c$);
-- select cron.schedule('aureonx-cron-history-cleanup', '17 3 * * *',
--   $c$ delete from cron.job_run_details where end_time < now() - interval '2 days'; $c$);
-- -----------------------------------------------------------------------------
