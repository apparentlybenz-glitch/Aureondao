-- =============================================================================
-- Forex money path: instruments, periods, price history, timed positions,
-- settlement and the void job. Prices arrive through ingest_fx_rates (the hourly
-- Open Exchange Rates table, USD base); fetching it is a later change.
--
-- Owner decisions (Forex):
--   * Forex trades like Options: a direction, a duration, a premium and a fee
--     debited from the forex wallet, settled at expiry. Payout, draw and void
--     rules are the Options rules (docs/decisions.md Part 1e).
--   * Entry = the newest fx_prices row at open, refused (PRICE_STALE) unless it
--     is at most 60 minutes old and not in the future.
--   * Settle = the first fx_prices row with expires_at <= ts <= expires_at + 2 h
--     and ts > entry_price_at, compared with the entry at the instrument's
--     price_decimals. Equal is a draw: premium refunded, fee kept.
--   * A position still open after expires_at + 2 h 15 min is void: premium and
--     fee refunded, by a SQL-only cron job.
--   * Closed windows (America/New_York): fx Friday 17:00 to Sunday 17:00; metal
--     Friday 17:00 to Sunday 18:00 plus 17:00 to 18:00 Monday to Thursday. An
--     open whose expires_at + 70 min passes the next closure start is refused.
--   * Forex instruments never go into markets; crypto Options is untouched.
--
-- Locks, as in Options: open_fx_position locks the forex wallet only. Settlement
-- and voiding lock position rows first (FOR UPDATE SKIP LOCKED), then wallets
-- ascending (private.lock_wallets). ingest_fx_rates first takes FOR NO KEY UPDATE
-- on the instrument rows, so two ingests run one after the other; that mode does
-- not conflict with the KEY SHARE lock a position insert takes on its instrument.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Types. Direction, status and result reuse the Options enums unchanged.
-- -----------------------------------------------------------------------------
create type public.fx_class as enum ('fx', 'metal');

-- -----------------------------------------------------------------------------
-- 2. Tables
-- -----------------------------------------------------------------------------

-- 2.1 fx_instruments: id is BASE-QUOTE (EUR-USD), shown as EUR/USD. Every price
-- is rate[quote] / rate[base] from the USD-based table, with rate[USD] = 1.
create table public.fx_instruments (
  id              text primary key,
  base            text not null check (base ~ '^[A-Z]{3}$'),
  quote           text not null check (quote ~ '^[A-Z]{3}$'),
  class           public.fx_class not null,
  price_decimals  integer not null check (price_decimals between 0 and 8),
  sort_order      integer not null,
  enabled         boolean not null default false,
  check (id = base || '-' || quote),
  check (base <> quote)
);

insert into public.fx_instruments (id, base, quote, class, price_decimals, sort_order, enabled) values
  ('EUR-USD', 'EUR', 'USD', 'fx',    5,  1, true),
  ('GBP-USD', 'GBP', 'USD', 'fx',    5,  2, true),
  ('USD-JPY', 'USD', 'JPY', 'fx',    3,  3, true),
  ('USD-CHF', 'USD', 'CHF', 'fx',    5,  4, true),
  ('USD-CAD', 'USD', 'CAD', 'fx',    5,  5, true),
  ('AUD-USD', 'AUD', 'USD', 'fx',    5,  6, true),
  ('NZD-USD', 'NZD', 'USD', 'fx',    5,  7, true),
  ('EUR-GBP', 'EUR', 'GBP', 'fx',    5,  8, true),
  ('EUR-JPY', 'EUR', 'JPY', 'fx',    3,  9, true),
  ('GBP-JPY', 'GBP', 'JPY', 'fx',    3, 10, true),
  ('AUD-JPY', 'AUD', 'JPY', 'fx',    3, 11, true),
  ('XAU-USD', 'XAU', 'USD', 'metal', 2, 12, true),
  ('XAG-USD', 'XAG', 'USD', 'metal', 3, 13, true),
  ('EUR-CHF', 'EUR', 'CHF', 'fx',    5, 14, false),
  ('EUR-AUD', 'EUR', 'AUD', 'fx',    5, 15, false),
  ('GBP-AUD', 'GBP', 'AUD', 'fx',    5, 16, false),
  ('NZD-JPY', 'NZD', 'JPY', 'fx',    3, 17, false);

-- 2.2 fx_periods: one row per duration, the same columns and rules as
-- option_periods (including the minimum premium floor of 20261030130000).
-- Changed only through admin_set_fx_period; the rate is copied onto each
-- position at open.
create table public.fx_periods (
  duration_s         integer primary key check (duration_s between 3600 and 86400),
  profit_rate_bps    integer not null check (profit_rate_bps between 0 and 100000),
  fee_bps            integer not null check (fee_bps between 0 and 1000),
  min_premium_cents  bigint  not null check (min_premium_cents > 0),
  enabled            boolean not null default false,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references auth.users (id) on delete set null,
  check (not enabled or profit_rate_bps > 0),
  constraint fx_periods_min_premium_floor
    check (not enabled or (profit_rate_bps - fee_bps)::bigint * min_premium_cents > 20000)
);

-- 1 h takes the rate, fee and minimum premium of the 30 s Options period as it
-- stands when this runs; 2 h and 4 h start disabled like the unused Options rows.
insert into public.fx_periods (duration_s, profit_rate_bps, fee_bps, min_premium_cents, enabled)
select 3600, profit_rate_bps, fee_bps, min_premium_cents, true
  from public.option_periods where duration_s = 30;
insert into public.fx_periods (duration_s, profit_rate_bps, fee_bps, min_premium_cents, enabled)
select d, 0, fee_bps, min_premium_cents, false
  from public.option_periods, (values (7200), (14400)) v(d) where duration_s = 30;
do $$
begin
  if (select count(*) from public.fx_periods) <> 3 then
    raise exception 'forex_money: the 30 s option_periods row is missing';
  end if;
end $$;

-- 2.3 fx_prices: the price history, one row per instrument per table timestamp,
-- rounded to the instrument's price_decimals. Written only by ingest_fx_rates,
-- forward-only in time per instrument.
create table public.fx_prices (
  instrument_id  text not null references public.fx_instruments (id),
  ts             timestamptz not null,       -- table timestamp, clamped to <= now() at ingest
  price          numeric not null check (price > 0 and price <> 'NaN'::numeric),
  source         text not null check (source in ('oxr')),
  ingested_at    timestamptz not null default now(),
  primary key (instrument_id, ts)
);

-- 2.4 fx_positions: the options_positions shape. Times come from now() inside
-- open_fx_position; the status CHECK pins the settle and void windows.
create table public.fx_positions (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profiles (id) on delete cascade,
  instrument_id      text not null references public.fx_instruments (id),
  direction          public.option_direction not null,
  duration_s         integer not null check (duration_s > 0),
  premium_cents      bigint not null check (premium_cents > 0),
  fee_cents          bigint not null check (fee_cents >= 0),
  profit_rate_bps    integer not null check (profit_rate_bps > 0),   -- snapshot of fx_periods
  entry_price        numeric not null check (entry_price > 0 and entry_price <> 'NaN'::numeric),
  entry_price_at     timestamptz not null,                            -- ts of the entry fx_prices row
  created_at         timestamptz not null,
  expires_at         timestamptz not null,
  status             public.option_status not null default 'open',
  result             public.option_result,
  settle_price       numeric,
  settle_price_at    timestamptz,
  payout_cents       bigint,
  settled_at         timestamptz,
  client_request_id  uuid not null,
  unique (user_id, client_request_id),
  check (entry_price_at <= created_at),
  check (expires_at = created_at + make_interval(secs => duration_s)),
  check (case status
    when 'open' then result is null and settle_price is null and settle_price_at is null
                     and payout_cents is null and settled_at is null
    when 'settled' then result is not null and settle_price > 0 and settle_price <> 'NaN'::numeric
                     and settle_price_at >= expires_at and settle_price_at <= expires_at + interval '2 hours'
                     and settle_price_at > entry_price_at
                     and settled_at is not null and settled_at >= settle_price_at
                     and payout_cents = case result when 'loss' then 0
                                                    when 'draw' then premium_cents
                                                    else premium_cents + floor(premium_cents::numeric * profit_rate_bps / 10000)::bigint
                                        end
    when 'void' then result is null and settle_price is null and settle_price_at is null
                     and payout_cents = premium_cents + fee_cents
                     and settled_at > expires_at + interval '2 hours 15 minutes'
  end)
);
create index fx_positions_due_idx on public.fx_positions (instrument_id, expires_at) where status = 'open';
create index fx_positions_user_created_idx on public.fx_positions (user_id, created_at desc);

-- -----------------------------------------------------------------------------
-- 3. Market hours (America/New_York; AT TIME ZONE applies the DST in force on
-- each local date). Both take the instant as a parameter so tests can use
-- fixed instants.
-- -----------------------------------------------------------------------------

-- 3.1 fx: closed Friday 17:00 to Sunday 17:00. metal: closed Friday 17:00 to
-- Sunday 18:00, and 17:00 to 18:00 Monday to Thursday.
create or replace function private.fx_is_closed(p_class public.fx_class, p_at timestamptz)
returns boolean
language sql
stable
set search_path = ''
as $$
  with l as (
    select extract(isodow from p_at at time zone 'America/New_York')::integer d,
           (p_at at time zone 'America/New_York')::time t
  )
  select case p_class
    when 'fx' then (d = 5 and t >= time '17:00') or d = 6 or (d = 7 and t < time '17:00')
    else (d = 5 and t >= time '17:00') or d = 6 or (d = 7 and t < time '18:00')
         or (d between 1 and 4 and t >= time '17:00' and t < time '18:00')
  end
  from l;
$$;

-- 3.2 The start of the first closure that begins after p_at. Every closure
-- starts at 17:00 New York: on Fridays for fx, on Monday to Friday for metal.
create or replace function private.fx_next_close(p_class public.fx_class, p_at timestamptz)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select min(c.at)
    from generate_series(0, 7) i,
         lateral (select ((p_at at time zone 'America/New_York')::date + i) + time '17:00' as local_at) l,
         lateral (select l.local_at at time zone 'America/New_York' as at) c
   where c.at > p_at
     and (extract(isodow from l.local_at) = 5
          or (p_class = 'metal' and extract(isodow from l.local_at) between 1 and 4));
$$;

-- -----------------------------------------------------------------------------
-- 4. Settlement and voiding (no client EXECUTE)
-- -----------------------------------------------------------------------------

-- 4.1 Settle the open positions of one instrument against one newly inserted
-- price. Called by ingest_fx_rates in the transaction that wrote the price, so
-- each position settles at the first price inside its window. Returns the
-- number settled.
create or replace function private.settle_fx(p_instrument_id text, p_price numeric, p_ts timestamptz)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids     uuid[];
  v_dec     integer;
  r         public.fx_positions;
  v_result  public.option_result;
  v_entry   numeric;
  v_settle  numeric;
  v_profit  bigint;
  v_payout  bigint;
  v_wallet  uuid;
  v_n       integer := 0;
begin
  select price_decimals into v_dec from public.fx_instruments where id = p_instrument_id;
  if not found then return 0; end if;

  with c as (
    select p.id
      from public.fx_positions p
     where p.instrument_id = p_instrument_id
       and p.status = 'open'
       and p.expires_at <= p_ts
       and p.expires_at >= p_ts - interval '2 hours'
       and p.entry_price_at < p_ts
     order by p.expires_at, p.id
     limit 500
       for update of p skip locked
  )
  select array_agg(id order by id) into v_ids from c;
  if v_ids is null then return 0; end if;

  perform private.lock_wallets(array(
    select w.id from public.wallets w
      join public.fx_positions p on p.user_id = w.user_id
     where p.id = any (v_ids) and w.account = 'forex'));

  v_settle := round(p_price, v_dec);
  for r in select * from public.fx_positions where id = any (v_ids) order by id loop
    v_entry  := round(r.entry_price, v_dec);
    v_profit := 0;
    if v_settle = v_entry then
      v_result := 'draw';
      v_payout := r.premium_cents;
    elsif (r.direction = 'rise') = (v_settle > v_entry) then
      v_result := 'win';
      v_profit := floor(r.premium_cents::numeric * r.profit_rate_bps / 10000);
      v_payout := r.premium_cents + v_profit;
    else
      v_result := 'loss';
      v_payout := 0;
    end if;

    update public.fx_positions
       set status = 'settled', result = v_result, settle_price = p_price, settle_price_at = p_ts,
           payout_cents = v_payout, settled_at = now()
     where id = r.id and status = 'open';
    if not found then continue; end if;

    select id into v_wallet from public.wallets where user_id = r.user_id and account = 'forex';
    if v_result = 'win' then
      perform private.wallet_apply(v_wallet, v_payout, 0, 'forex_close', 'forex_position', r.id,
                                   p_pnl_cents => v_profit);
    elsif v_result = 'loss' then
      perform private.wallet_apply(v_wallet, 0, 0, 'forex_close', 'forex_position', r.id,
                                   p_pnl_cents => -r.premium_cents);
    else
      perform private.wallet_apply(v_wallet, v_payout, 0, 'forex_refund', 'forex_position', r.id);
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- 4.2 Void positions that found no settle price: still open more than
-- 2 h 15 min after expiry. Premium and fee refunded; the refund carries PnL +fee,
-- so a void nets 0. Run by pg_cron only.
create or replace function private.void_stale_fx()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids     uuid[];
  r         public.fx_positions;
  v_wallet  uuid;
  v_n       integer := 0;
begin
  with c as (
    select p.id
      from public.fx_positions p
     where p.status = 'open'
       and p.expires_at < now() - interval '2 hours 15 minutes'
     order by p.expires_at, p.id
     limit 500
       for update of p skip locked
  )
  select array_agg(id order by id) into v_ids from c;
  if v_ids is null then return 0; end if;

  perform private.lock_wallets(array(
    select w.id from public.wallets w
      join public.fx_positions p on p.user_id = w.user_id
     where p.id = any (v_ids) and w.account = 'forex'));

  for r in select * from public.fx_positions where id = any (v_ids) order by id loop
    update public.fx_positions
       set status = 'void', payout_cents = r.premium_cents + r.fee_cents, settled_at = now()
     where id = r.id and status = 'open';
    if not found then continue; end if;

    select id into v_wallet from public.wallets where user_id = r.user_id and account = 'forex';
    perform private.wallet_apply(v_wallet, r.premium_cents + r.fee_cents, 0, 'forex_refund',
                                 'forex_position', r.id, p_pnl_cents => r.fee_cents);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Public RPCs
-- -----------------------------------------------------------------------------

-- 5.1 open_fx_position: no price argument. The order of checks is open_option's,
-- plus the market hours and the price age. Idempotent on p_client_request_id:
-- the same key with the same parameters returns the first position's id;
-- different parameters raise IDEMPOTENCY_CONFLICT. Locks: the forex wallet only.
create or replace function public.open_fx_position(
  p_instrument_id     text,
  p_direction         public.option_direction,
  p_duration_s        integer,
  p_premium_cents     bigint,
  p_client_request_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- The oldest entry price accepted.
  c_max_price_age constant interval := interval '60 minutes';
  -- The settle print can land up to one print interval (60 min) plus the fetch
  -- margin (10 min) after expiry; it must still come before the market closes.
  c_close_margin  constant interval := interval '70 minutes';
  v_uid     uuid := auth.uid();
  v_i       public.fx_instruments;
  v_p       public.fx_periods;
  v_px      public.fx_prices;
  v_wallet  public.wallets;
  v_fee     bigint;
  v_expires timestamptz;
  v_pos     public.fx_positions;
begin
  if v_uid is null then raise exception 'UNAUTHENTICATED'; end if;
  perform private.assert_active(v_uid);
  if p_instrument_id is null or p_direction is null or p_duration_s is null
     or p_premium_cents is null or p_client_request_id is null then
    raise exception 'INVALID_ARGUMENT';
  end if;
  -- Overflow guard (bigint math below), the same cap as open_option.
  -- Not a product maximum: the wallet balance is the real limit.
  if p_premium_cents > 100000000000 then raise exception 'INVALID_AMOUNT'; end if;

  select * into v_wallet from public.wallets where user_id = v_uid and account = 'forex';
  if not found then raise exception 'WALLET_NOT_FOUND'; end if;
  perform private.lock_wallets(array[v_wallet.id]);

  -- After the lock, so a concurrent call with the same key has committed.
  select * into v_pos from public.fx_positions
   where user_id = v_uid and client_request_id = p_client_request_id;
  if found then
    if v_pos.instrument_id <> p_instrument_id or v_pos.direction <> p_direction
       or v_pos.duration_s <> p_duration_s or v_pos.premium_cents <> p_premium_cents then
      raise exception 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_pos.id;
  end if;

  select * into v_i from public.fx_instruments where id = p_instrument_id;
  if not found then raise exception 'MARKET_NOT_FOUND'; end if;
  if not v_i.enabled then raise exception 'MARKET_DISABLED'; end if;

  select * into v_p from public.fx_periods where duration_s = p_duration_s;
  if not found then raise exception 'PERIOD_NOT_FOUND'; end if;
  if not v_p.enabled or v_p.profit_rate_bps <= 0 then raise exception 'PERIOD_DISABLED'; end if;
  if p_premium_cents < v_p.min_premium_cents then
    raise exception 'BELOW_MIN_PREMIUM' using detail = format('min_cents=%s', v_p.min_premium_cents);
  end if;

  v_expires := now() + make_interval(secs => p_duration_s);
  if private.fx_is_closed(v_i.class, now()) then raise exception 'MARKET_CLOSED'; end if;
  if v_expires + c_close_margin > private.fx_next_close(v_i.class, now()) then
    raise exception 'MARKET_CLOSED' using detail = 'closes_before_expiry';
  end if;

  -- Entry price: the newest stored price, at most c_max_price_age old.
  select * into v_px from public.fx_prices
   where instrument_id = p_instrument_id
   order by ts desc
   limit 1;
  if not found or v_px.ts <= now() - c_max_price_age or v_px.ts > now() then
    raise exception 'PRICE_STALE';
  end if;

  v_fee := ceil(p_premium_cents * v_p.fee_bps / 10000.0);

  select * into v_wallet from public.wallets where id = v_wallet.id;
  if v_wallet.available_cents < p_premium_cents + v_fee then
    raise exception 'INSUFFICIENT_FUNDS'
      using detail = format('available=%s required=%s', v_wallet.available_cents, p_premium_cents + v_fee);
  end if;

  insert into public.fx_positions (user_id, instrument_id, direction, duration_s, premium_cents, fee_cents,
                                   profit_rate_bps, entry_price, entry_price_at, created_at, expires_at,
                                   client_request_id)
  values (v_uid, p_instrument_id, p_direction, p_duration_s, p_premium_cents, v_fee,
          v_p.profit_rate_bps, v_px.price, v_px.ts, now(), v_expires, p_client_request_id)
  returning * into v_pos;

  perform private.wallet_apply(v_wallet.id, -p_premium_cents, 0, 'forex_margin', 'forex_position', v_pos.id);
  if v_fee > 0 then
    perform private.wallet_apply(v_wallet.id, -v_fee, 0, 'fee', 'forex_position', v_pos.id,
                                 p_pnl_cents => -v_fee);
  end if;
  return v_pos.id;
end;
$$;

-- 5.2 ingest_fx_rates (service_role only): one raw Open Exchange Rates
-- latest.json body as text. It is cast to jsonb here, so every rate stays an
-- exact numeric and never passes through a JavaScript float. Each instrument is
-- rate[quote] / rate[base] with rate[USD] = 1, rounded half up once to its
-- price_decimals (exactly: div() is integer division of numerics). An instrument
-- whose rate is missing, not a number or not positive is skipped and reported.
-- The whole table is refused (an exception, nothing written) only for a bad
-- body, base or timestamp, or when every instrument was skipped. Each written
-- price then settles its instrument's due positions in its own subtransaction.
create or replace function public.ingest_fx_rates(p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_body     jsonb;
  v_rates    jsonb;
  v_ts       timestamptz;
  i          public.fx_instruments;
  v_b        numeric;
  v_q        numeric;
  v_scale    numeric;
  v_price    numeric;
  v_ok       integer := 0;
  v_ign      integer := 0;   -- valid, but not newer than the stored price
  v_set      integer := 0;   -- positions settled
  v_err      integer := 0;   -- instruments whose settlement failed (price still written)
  v_skipped  text[] := '{}';
  v_ids      text[] := '{}';         -- written prices, in order
  v_prices   numeric[] := '{}';
begin
  begin
    v_body := p_body::jsonb;
  exception when invalid_text_representation then
    raise exception 'FX_INVALID_BODY';
  end;
  if v_body is null or jsonb_typeof(v_body) <> 'object' or jsonb_typeof(v_body -> 'rates') is distinct from 'object' then
    raise exception 'FX_INVALID_BODY';
  end if;
  if v_body ->> 'base' is distinct from 'USD' then raise exception 'FX_INVALID_BASE'; end if;
  if jsonb_typeof(v_body -> 'timestamp') is distinct from 'number'
     or (v_body ->> 'timestamp')::numeric <> trunc((v_body ->> 'timestamp')::numeric)
     or abs((v_body ->> 'timestamp')::numeric) > 100000000000 then
    raise exception 'FX_INVALID_TIMESTAMP';
  end if;
  v_ts := to_timestamp((v_body ->> 'timestamp')::numeric);
  if v_ts <= now() - interval '2 hours' or v_ts > now() + interval '5 minutes' then
    raise exception 'FX_INVALID_TIMESTAMP' using detail = format('ts=%s', v_ts);
  end if;
  v_ts := least(v_ts, now());
  v_rates := v_body -> 'rates';

  -- One ingest at a time (see the header on locks).
  perform 1 from public.fx_instruments order by id for no key update;

  for i in select * from public.fx_instruments order by sort_order, id loop
    v_b := case when i.base = 'USD' then 1
                when jsonb_typeof(v_rates -> i.base) = 'number' then (v_rates ->> i.base)::numeric end;
    v_q := case when i.quote = 'USD' then 1
                when jsonb_typeof(v_rates -> i.quote) = 'number' then (v_rates ->> i.quote)::numeric end;
    if v_b is null or v_q is null or v_b <= 0 or v_q <= 0 then
      v_skipped := v_skipped || i.id;
      continue;
    end if;
    -- round(q / b, d) half up = floor(q x 10^d / b + 1/2) = div(2 q 10^d + b, 2 b) / 10^d
    v_scale := 10::numeric ^ i.price_decimals;
    v_price := round(div(2 * v_q * v_scale + v_b, 2 * v_b) / v_scale, i.price_decimals);
    if v_price <= 0 then
      v_skipped := v_skipped || i.id;
      continue;
    end if;

    insert into public.fx_prices (instrument_id, ts, price, source)
    select i.id, v_ts, v_price, 'oxr'
     where not exists (select 1 from public.fx_prices p where p.instrument_id = i.id and p.ts >= v_ts)
    on conflict do nothing;
    if found then
      v_ok := v_ok + 1;
      v_ids := v_ids || i.id; v_prices := v_prices || v_price;
    else
      v_ign := v_ign + 1;
    end if;
  end loop;

  if v_ok + v_ign = 0 then raise exception 'FX_NO_RATES'; end if;

  -- Each instrument settles in its own subtransaction: a failure rolls back only
  -- that instrument's settlement, never the prices. Its due positions are
  -- retried by the next price in the window, else voided by the void job.
  for n in 1 .. coalesce(array_length(v_ids, 1), 0) loop
    begin
      v_set := v_set + private.settle_fx(v_ids[n], v_prices[n], v_ts);
    exception when others then
      v_err := v_err + 1;
      raise warning 'aureonx settle_fx failed for %: %', v_ids[n], sqlerrm;
    end;
  end loop;
  return jsonb_build_object('ts', v_ts, 'accepted', v_ok, 'ignored', v_ign, 'skipped', to_jsonb(v_skipped),
                            'settled', v_set, 'settle_errors', v_err);
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Admin RPC: the admin_set_option_period checks (claim, live admin row).
-- Updates one existing period; open positions keep the rate copied at open.
-- -----------------------------------------------------------------------------
create or replace function public.admin_set_fx_period(
  p_duration_s         integer,
  p_profit_rate_bps    integer,
  p_fee_bps            integer,
  p_min_premium_cents  bigint,
  p_enabled            boolean
)
returns public.fx_periods
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin uuid := auth.uid();
  v_p     public.fx_periods;
begin
  if v_admin is null then raise exception 'UNAUTHENTICATED'; end if;
  if coalesce(auth.jwt() ->> 'user_role', '') <> 'admin' then raise exception 'FORBIDDEN'; end if;
  if not private.is_admin() then raise exception 'FORBIDDEN'; end if;

  if p_duration_s is null or p_enabled is null
     or p_profit_rate_bps is null or p_profit_rate_bps not between 0 and 100000
     or p_fee_bps is null or p_fee_bps not between 0 and 1000
     or p_min_premium_cents is null or p_min_premium_cents <= 0
     or (p_enabled and p_profit_rate_bps = 0) then
    raise exception 'INVALID_ARGUMENT';
  end if;

  update public.fx_periods
     set profit_rate_bps = p_profit_rate_bps, fee_bps = p_fee_bps, min_premium_cents = p_min_premium_cents,
         enabled = p_enabled, updated_at = now(), updated_by = v_admin
   where duration_s = p_duration_s
  returning * into v_p;
  if not found then raise exception 'PERIOD_NOT_FOUND'; end if;

  insert into public.admin_audit_log (admin_id, action, payload)
  values (v_admin, 'set_fx_period', to_jsonb(v_p));
  return v_p;
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. Row Level Security and grants
-- -----------------------------------------------------------------------------
alter table public.fx_instruments enable row level security;
alter table public.fx_periods     enable row level security;
alter table public.fx_prices      enable row level security;
alter table public.fx_positions   enable row level security;

create policy fx_instruments_select on public.fx_instruments for select to authenticated using (enabled);
create policy fx_periods_select on public.fx_periods for select to authenticated using (true);
create policy fx_prices_select on public.fx_prices for select to authenticated using (true);
create policy fx_positions_select on public.fx_positions for select to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.fx_instruments, public.fx_periods, public.fx_prices, public.fx_positions from anon, authenticated;
grant select on public.fx_instruments, public.fx_periods, public.fx_prices, public.fx_positions to authenticated;

revoke all on function private.fx_is_closed(public.fx_class, timestamptz)   from public, anon, authenticated;
revoke all on function private.fx_next_close(public.fx_class, timestamptz)  from public, anon, authenticated;
revoke all on function private.settle_fx(text, numeric, timestamptz)        from public, anon, authenticated;
revoke all on function private.void_stale_fx()                              from public, anon, authenticated;
revoke all on function public.open_fx_position(text, public.option_direction, integer, bigint, uuid) from public, anon;
revoke all on function public.ingest_fx_rates(text)                         from public, anon, authenticated;
revoke all on function public.admin_set_fx_period(integer, integer, integer, bigint, boolean) from public, anon;

grant execute on function public.open_fx_position(text, public.option_direction, integer, bigint, uuid) to authenticated;
grant execute on function public.ingest_fx_rates(text) to service_role;
grant execute on function public.admin_set_fx_period(integer, integer, integer, bigint, boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- 8. Realtime: positions (own rows, RLS per subscriber) and new prices.
-- -----------------------------------------------------------------------------
alter publication supabase_realtime add table public.fx_positions, public.fx_prices;

-- -----------------------------------------------------------------------------
-- 9. Schedule: the void job, SQL only, every minute.
-- -----------------------------------------------------------------------------
select cron.schedule('aureonx-fx-void', '* * * * *', $c$ select private.void_stale_fx(); $c$);
