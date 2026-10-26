-- =============================================================================
-- Slice 4 Part A: server price snapshots, the price feed, Spot market orders.
-- Cut from the proposal in 20261025000000_initial_schema.sql (O18). Applied
-- through the Management API. Limit orders and fund reservation are not here.
--
-- Owner decisions (slice 4):
--   * Market orders fill at the latest server snapshot: buy at the ask, sell at
--     the bid. The order RPC takes no price argument and refuses a snapshot
--     older than spot_config.max_price_age_s (60 s, capped at 60 by a CHECK).
--   * The fee rate lives in spot_config (0.1% = 10 bps), never in code.
--   * Snapshots come from the price-ingest Edge Function (Vision, KuCoin as the
--     fallback), fired by pg_cron through pg_net only while there is demand.
--
-- Cent rounding always goes against the user, so the platform never creates money:
--   buy cost      = ceil(qty x ask x 100)
--   sell proceeds = floor(qty x bid x 100)
--   fee           = ceil(order value in cents x fee_bps / 10000)
--
-- Secrets are not in this file. Vault holds project_url and price_ingest_secret;
-- the Edge Function holds PRICE_INGEST_SECRET (same value). See docs/data-model.md §16.
-- =============================================================================

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

-- -----------------------------------------------------------------------------
-- 1. Types
-- -----------------------------------------------------------------------------
create type public.order_side as enum ('buy', 'sell');

-- -----------------------------------------------------------------------------
-- 2. markets: quantity precision and minimum order value (Vision exchangeInfo,
--    2026-10-26: LOT_SIZE stepSize is a power of ten and equals minQty on all
--    20 markets; NOTIONAL minNotional is 5 USDT, 1 USDT for DOGE and PEPE).
-- -----------------------------------------------------------------------------
alter table public.markets
  add column qty_decimals       integer check (qty_decimals between 0 and 18),
  add column min_notional_cents bigint  check (min_notional_cents > 0);

update public.markets m
   set qty_decimals = v.qd, min_notional_cents = v.mn
  from (values
    ('BTC-USDT', 5, 500), ('ETH-USDT', 4, 500), ('ZEC-USDT', 3, 500), ('SOL-USDT', 3, 500),
    ('XRP-USDT', 1, 500), ('NEAR-USDT', 1, 500), ('BNB-USDT', 3, 500), ('ENA-USDT', 2, 500),
    ('WLD-USDT', 1, 500), ('SUI-USDT', 1, 500), ('PEPE-USDT', 0, 100), ('UNI-USDT', 2, 500),
    ('DOGE-USDT', 0, 100), ('TRX-USDT', 1, 500), ('QNT-USDT', 3, 500), ('HYPE-USDT', 3, 500),
    ('LINK-USDT', 2, 500), ('TAO-USDT', 4, 500), ('ADA-USDT', 1, 500), ('AAVE-USDT', 3, 500)
  ) as v(id, qd, mn)
 where m.id = v.id;

alter table public.markets
  alter column qty_decimals       set not null,
  alter column min_notional_cents set not null;

-- -----------------------------------------------------------------------------
-- 3. Tables
-- -----------------------------------------------------------------------------

-- 3.1 spot_config: one row. The fee rate and the snapshot age limit for fills.
create table public.spot_config (
  id               boolean primary key default true check (id),
  fee_bps          integer not null check (fee_bps between 0 and 1000),        -- 10 = 0.1%
  max_price_age_s  integer not null check (max_price_age_s between 1 and 60),
  updated_at       timestamptz not null default now()
);
insert into public.spot_config (fee_bps, max_price_age_s) values (10, 60);

-- 3.2 price_snapshots: latest server-fetched best bid/ask per market (upserted,
-- forward-only in time). Postgres orders NaN above every number, so NaN is
-- excluded explicitly.
create table public.price_snapshots (
  market_id    text primary key references public.markets (id) on delete cascade,
  bid          numeric(38,18) not null check (bid > 0 and bid <> 'NaN'::numeric),
  ask          numeric(38,18) not null check (ask > 0 and ask <> 'NaN'::numeric),
  fetched_at   timestamptz not null,          -- source timestamp, clamped to <= now() at ingest
  source       text not null check (source in ('vision', 'kucoin')),
  ingested_at  timestamptz not null default now(),
  check (ask >= bid)
);

-- 3.3 system_state: one row, the price-feed demand window.
create table public.system_state (
  id                  boolean primary key default true check (id),
  price_demand_until  timestamptz not null default '-infinity'
);
insert into public.system_state default values;

-- 3.4 spot_holdings: base-asset quantity in the Spot sub-wallet, with the
-- average-cost basis used for realized PnL on sells.
create table public.spot_holdings (
  user_id           uuid not null references public.profiles (id) on delete cascade,
  asset             text not null check (asset ~ '^[A-Z0-9]{2,12}$'),
  available_qty     numeric(38,18) not null default 0 check (available_qty >= 0),
  cost_basis_cents  bigint not null default 0 check (cost_basis_cents >= 0),
  updated_at        timestamptz not null default now(),
  primary key (user_id, asset)
);

create trigger spot_holdings_guard_balance
  before update on public.spot_holdings
  for each row execute function private.guard_balance_write();

-- 3.5 orders: filled Spot market orders. All-or-nothing, so no fills table.
create table public.orders (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.profiles (id) on delete cascade,
  wallet_id           uuid not null references public.wallets (id) on delete cascade,
  market_id           text not null references public.markets (id),
  side                public.order_side not null,
  qty                 numeric(38,18) not null check (qty > 0),
  price               numeric(38,18) not null check (price > 0),   -- the snapshot ask (buy) or bid (sell)
  price_at            timestamptz not null,                        -- fetched_at of that snapshot
  price_source        text not null,
  notional_cents      bigint not null check (notional_cents > 0),  -- cost (buy) or proceeds (sell)
  fee_bps             integer not null,
  fee_cents           bigint not null check (fee_cents >= 0),
  realized_pnl_cents  bigint,                                      -- sells only
  client_request_id   uuid not null,
  created_at          timestamptz not null default now(),
  unique (user_id, client_request_id),
  check ((side = 'sell') = (realized_pnl_cents is not null))
);
create index orders_user_created_idx on public.orders (user_id, created_at desc);

-- -----------------------------------------------------------------------------
-- 4. Private helpers
-- -----------------------------------------------------------------------------

-- 4.1 Strict decimal parser for text inputs: no sign, exponent, NaN or Infinity.
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

-- 4.2 "84242.9", 2 -> "84,242.90". For Bills memos only.
create or replace function private.format_amount(p_n numeric, p_decimals integer)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_s    text := round(p_n, p_decimals)::text;
  v_int  text := split_part(v_s, '.', 1);
  v_frac text := split_part(v_s, '.', 2);
begin
  v_int := reverse(regexp_replace(reverse(v_int), '([0-9]{3})(?=[0-9])', '\1,', 'g'));
  return v_int || case when v_frac <> '' then '.' || v_frac else '' end;
end;
$$;

-- 4.3 Create (if missing) and lock a holding row. Callers lock the wallet first.
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

-- 4.4 THE asset mutation primitive. Caller holds the spot wallet lock, then the
-- holding lock. The asset leg is recorded on the matching ledger row.
create or replace function private.holding_apply(
  p_user_id     uuid,
  p_asset       text,
  p_qty_delta   numeric,
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
  if v_h.available_qty + p_qty_delta < 0 then
    raise exception 'INSUFFICIENT_ASSET'
      using detail = format('available=%s required=%s', v_h.available_qty, -p_qty_delta);
  end if;
  if v_h.cost_basis_cents + p_cost_delta < 0 then
    raise exception 'INVARIANT_HOLDING_NEGATIVE';
  end if;
  perform set_config('aureonx.balance_write', 'on', true);
  update public.spot_holdings
     set available_qty    = available_qty + p_qty_delta,
         cost_basis_cents = cost_basis_cents + p_cost_delta,
         updated_at       = now()
   where user_id = p_user_id and asset = p_asset
  returning * into v_h;
  perform set_config('aureonx.balance_write', 'off', true);
  return v_h;
end;
$$;

-- 4.5 Push the demand window forward (writes at most about once a minute).
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

-- 4.6 Price tick, run by pg_cron every 10 s. Fires price-ingest only while the
-- demand window is open. Secrets come from Vault and are never logged.
create or replace function private.price_tick()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url    text;
  v_secret text;
begin
  if not exists (select 1 from public.system_state where id and price_demand_until > now()) then
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
                                               'x-region', 'eu-west-1',
                                               'x-aureonx-cron-secret', v_secret),
    body                 := '{}'::jsonb,
    timeout_milliseconds := 8000
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Public RPCs (authenticated)
-- -----------------------------------------------------------------------------

-- 5.1 request_price_feed: a visible trading screen calls this on mount and as a
-- heartbeat. Returns the end of the demand window.
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

-- 5.2 spot_market_order: fills now at the latest server snapshot or not at all.
-- No price argument. Idempotent on p_client_request_id: the same key with the
-- same parameters returns the first order; different parameters raise
-- IDEMPOTENCY_CONFLICT. Locks: spot wallet, then the holding.
create or replace function public.spot_market_order(
  p_market_id         text,
  p_side              public.order_side,
  p_qty               text,
  p_client_request_id uuid
)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := auth.uid();
  v_m         public.markets;
  v_cfg       public.spot_config;
  v_wallet    public.wallets;
  v_h         public.spot_holdings;
  v_s         public.price_snapshots;
  v_qty       numeric;
  v_price     numeric;
  v_value     numeric;     -- qty x price x 100, unrounded
  v_notional  bigint;
  v_fee       bigint;
  v_removed   bigint := 0; -- cost basis taken out by a sell
  v_pnl       bigint;
  v_o         public.orders;
begin
  if v_uid is null then raise exception 'UNAUTHENTICATED'; end if;
  if p_market_id is null or p_side is null or p_client_request_id is null then
    raise exception 'INVALID_ARGUMENT';
  end if;

  select * into v_m from public.markets where id = p_market_id;
  if not found then raise exception 'MARKET_NOT_FOUND'; end if;
  if not v_m.enabled then raise exception 'MARKET_DISABLED'; end if;

  v_qty := private.parse_decimal(p_qty);
  if v_qty <= 0 then raise exception 'INVALID_QTY'; end if;
  if v_qty <> trunc(v_qty, v_m.qty_decimals) then
    raise exception 'INVALID_QTY' using detail = format('max_decimals=%s', v_m.qty_decimals);
  end if;

  select * into v_wallet from public.wallets where user_id = v_uid and account = 'spot';
  if not found then raise exception 'WALLET_NOT_FOUND'; end if;
  perform private.lock_wallets(array[v_wallet.id]);
  v_h := private.lock_holding(v_uid, v_m.base);

  select * into v_o from public.orders
   where user_id = v_uid and client_request_id = p_client_request_id;
  if found then
    if v_o.market_id <> p_market_id or v_o.side <> p_side or v_o.qty <> v_qty then
      raise exception 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_o;
  end if;

  select * into v_cfg from public.spot_config where id;
  select * into v_s from public.price_snapshots s
   where s.market_id = p_market_id
     and s.fetched_at > now() - make_interval(secs => v_cfg.max_price_age_s)
     and s.fetched_at <= now();
  if not found then raise exception 'PRICE_STALE'; end if;

  v_price := case when p_side = 'buy' then v_s.ask else v_s.bid end;
  v_value := v_qty * v_price * 100;
  if v_value < v_m.min_notional_cents then
    raise exception 'BELOW_MIN_NOTIONAL' using detail = format('min_cents=%s', v_m.min_notional_cents);
  end if;
  if v_value > 100000000000000 then raise exception 'INVALID_QTY' using detail = 'too_large'; end if;

  v_notional := case when p_side = 'buy' then ceil(v_value) else floor(v_value) end;
  v_fee      := ceil(v_notional * v_cfg.fee_bps / 10000.0);

  select * into v_wallet from public.wallets where id = v_wallet.id;
  if p_side = 'buy' and v_wallet.available_cents < v_notional + v_fee then
    raise exception 'INSUFFICIENT_FUNDS'
      using detail = format('available=%s required=%s', v_wallet.available_cents, v_notional + v_fee);
  end if;
  if p_side = 'sell' then
    if v_h.available_qty < v_qty then
      raise exception 'INSUFFICIENT_ASSET'
        using detail = format('available=%s required=%s', v_h.available_qty, v_qty);
    end if;
    v_removed := floor(v_h.cost_basis_cents * v_qty / v_h.available_qty);
    v_pnl     := v_notional - v_fee - v_removed;
  end if;

  insert into public.orders (user_id, wallet_id, market_id, side, qty, price, price_at, price_source,
                             notional_cents, fee_bps, fee_cents, realized_pnl_cents, client_request_id)
  values (v_uid, v_wallet.id, p_market_id, p_side, v_qty, v_price, v_s.fetched_at, v_s.source,
          v_notional, v_cfg.fee_bps, v_fee, v_pnl, p_client_request_id)
  returning * into v_o;

  if p_side = 'buy' then
    perform private.wallet_apply(v_wallet.id, -v_notional, 0, 'spot_buy', 'order', v_o.id,
      p_asset => v_m.base, p_asset_delta => v_qty,
      p_memo => format('Bought %s %s at %s', private.format_amount(v_qty, scale(trim_scale(v_qty))),
                       v_m.base, private.format_amount(v_price, v_m.price_decimals)));
    -- The buy fee is part of the cost basis; it is realized when the asset is sold.
    perform private.holding_apply(v_uid, v_m.base, v_qty, v_notional + v_fee);
  else
    perform private.holding_apply(v_uid, v_m.base, -v_qty, -v_removed);
    perform private.wallet_apply(v_wallet.id, v_notional, 0, 'spot_sell', 'order', v_o.id,
      p_pnl_cents => v_notional - v_removed, p_asset => v_m.base, p_asset_delta => -v_qty,
      p_memo => format('Sold %s %s at %s', private.format_amount(v_qty, scale(trim_scale(v_qty))),
                       v_m.base, private.format_amount(v_price, v_m.price_decimals)));
  end if;
  if v_fee > 0 then
    perform private.wallet_apply(v_wallet.id, -v_fee, 0, 'fee', 'order', v_o.id,
      p_pnl_cents => case when p_side = 'sell' then -v_fee else 0 end,
      p_memo => 'Trading fee');
  end if;
  return v_o;
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Service RPC (service_role only): called by the price-ingest Edge Function.
-- Input: [{"market_id": "BTC-USDT", "bid": "84242.9", "ask": "84243.0",
--          "source": "vision", "ts": "<iso>"}]. Prices must be decimal strings.
-- Skips (and counts) an unknown or disabled market, a bad number, ask < bid,
-- or a timestamp more than 5 s ahead or more than 60 s behind the DB clock.
-- -----------------------------------------------------------------------------
create or replace function public.ingest_prices(p_prices jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  e      jsonb;
  v_m    public.markets;
  v_bid  numeric;
  v_ask  numeric;
  v_ts   timestamptz;
  v_ok   integer := 0;
  v_rej  integer := 0;
begin
  if p_prices is null or jsonb_typeof(p_prices) <> 'array' then raise exception 'INVALID_ARGUMENT'; end if;

  for e in select value from jsonb_array_elements(p_prices) loop
    begin
      select * into v_m from public.markets where id = e ->> 'market_id' and enabled;
      if not found or coalesce(jsonb_typeof(e -> 'bid'), '') <> 'string'
         or coalesce(jsonb_typeof(e -> 'ask'), '') <> 'string'
         or coalesce(e ->> 'source', '') not in ('vision', 'kucoin') then
        v_rej := v_rej + 1; continue;
      end if;
      v_bid := private.parse_decimal(e ->> 'bid');
      v_ask := private.parse_decimal(e ->> 'ask');
      v_ts  := (e ->> 'ts')::timestamptz;
      if v_bid <= 0 or v_ask < v_bid or v_ts is null
         or v_ts > now() + interval '5 seconds' or v_ts < now() - interval '60 seconds' then
        v_rej := v_rej + 1; continue;
      end if;
      v_ts := least(v_ts, now());

      insert into public.price_snapshots (market_id, bid, ask, fetched_at, source, ingested_at)
      values (v_m.id, v_bid, v_ask, v_ts, e ->> 'source', now())
      on conflict (market_id) do update
         set bid = excluded.bid, ask = excluded.ask, fetched_at = excluded.fetched_at,
             source = excluded.source, ingested_at = excluded.ingested_at
       where public.price_snapshots.fetched_at < excluded.fetched_at;
      v_ok := v_ok + 1;
    exception
      when raise_exception or invalid_text_representation or invalid_datetime_format
           or datetime_field_overflow or numeric_value_out_of_range or check_violation then
        v_rej := v_rej + 1;
    end;
  end loop;
  return jsonb_build_object('accepted', v_ok, 'rejected', v_rej);
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. Row Level Security and grants
-- -----------------------------------------------------------------------------
alter table public.spot_config     enable row level security;
alter table public.price_snapshots enable row level security;
alter table public.system_state    enable row level security;
alter table public.spot_holdings   enable row level security;
alter table public.orders          enable row level security;

create policy spot_config_select on public.spot_config for select to authenticated using (true);
create policy price_snapshots_select on public.price_snapshots for select to authenticated using (true);
create policy spot_holdings_select on public.spot_holdings for select to authenticated
  using (user_id = (select auth.uid()));
create policy orders_select on public.orders for select to authenticated
  using (user_id = (select auth.uid()));
-- system_state: no policy, not readable over the API.

revoke all on public.spot_config, public.price_snapshots, public.system_state,
              public.spot_holdings, public.orders from anon, authenticated;
grant select on public.spot_config, public.price_snapshots, public.spot_holdings, public.orders
  to authenticated;

revoke all on function private.parse_decimal(text)                         from public, anon, authenticated;
revoke all on function private.format_amount(numeric, integer)             from public, anon, authenticated;
revoke all on function private.lock_holding(uuid, text)                    from public, anon, authenticated;
revoke all on function private.holding_apply(uuid, text, numeric, bigint)  from public, anon, authenticated;
revoke all on function private.touch_price_demand()                        from public, anon, authenticated;
revoke all on function private.price_tick()                                from public, anon, authenticated;
revoke all on function public.request_price_feed()                         from public, anon;
revoke all on function public.spot_market_order(text, public.order_side, text, uuid) from public, anon;
revoke all on function public.ingest_prices(jsonb)                         from public, anon, authenticated;

grant execute on function public.request_price_feed() to authenticated;
grant execute on function public.spot_market_order(text, public.order_side, text, uuid) to authenticated;
grant execute on function public.ingest_prices(jsonb) to service_role;

-- -----------------------------------------------------------------------------
-- 8. Schedules. The tick is a no-op (one indexed read) while there is no demand.
-- cron.job_run_details is not cleaned up automatically, so purge it daily.
-- -----------------------------------------------------------------------------
select cron.schedule('aureonx-price-tick', '10 seconds', $c$ select private.price_tick(); $c$);
select cron.schedule('aureonx-cron-history-cleanup', '17 3 * * *',
  $c$ delete from cron.job_run_details where end_time < now() - interval '2 days'; $c$);
