-- =============================================================================
-- Slice 5 Part A: Options positions, settlement and the void job.
-- Cut from the proposal in 20261025000000_initial_schema.sql (O18). Applied
-- through the Management API.
--
-- Owner decisions (slice 5, docs/decisions.md Part 1e):
--   * O4: crypto underlyings only (markets.options_enabled: BTC, ETH, SOL).
--   * O5: entry = mid of the snapshot bid/ask, read inside open_option, at most
--     15 s old (a constant here, not config). The RPC takes no price.
--   * O12: settle = mid of the first snapshot with
--     expires_at <= fetched_at <= expires_at + 60 s. Settlement runs inside
--     ingest_prices, in the transaction that upserts that snapshot.
--   * O6: a position still open after expires_at + 90 s (60 s window plus the
--     30 s source age limit) is voided by a SQL-only cron job: premium and fee
--     refunded.
--   * O7: settle mid = entry mid is a draw: premium refunded, fee kept.
--   * Fee on top of the premium at open, rounded up like Spot's fee.
--     Win pays premium + floor(premium x profit_rate_bps / 10000).
--
-- Locks: position rows first (FOR UPDATE SKIP LOCKED, so settlers never wait
-- on each other), then wallets ascending by id (private.lock_wallets). Every
-- payout follows a guarded open -> settled/void update; only its winner pays.
-- option_refund is added to ledger_kind here, so it is referenced only inside
-- plpgsql bodies (a new enum value cannot be used in the adding transaction).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Types
-- -----------------------------------------------------------------------------
create type public.option_direction as enum ('rise', 'fall');
create type public.option_status    as enum ('open', 'settled', 'void');
create type public.option_result    as enum ('win', 'loss', 'draw');
alter type public.ledger_kind add value 'option_refund';

-- -----------------------------------------------------------------------------
-- 2. markets: which markets are options underlyings (O4).
-- -----------------------------------------------------------------------------
alter table public.markets add column options_enabled boolean not null default false;
update public.markets set options_enabled = true where id in ('BTC-USDT', 'ETH-USDT', 'SOL-USDT');

-- -----------------------------------------------------------------------------
-- 3. Tables
-- -----------------------------------------------------------------------------

-- 3.1 option_periods: one row per period. Rates live here, never in code; the
-- rate is copied onto each position at open. Rows are changed only through
-- admin_set_option_period.
create table public.option_periods (
  duration_s         integer primary key check (duration_s between 10 and 3600),
  profit_rate_bps    integer not null check (profit_rate_bps between 0 and 100000), -- 600 = 6%
  fee_bps            integer not null check (fee_bps between 0 and 1000),          -- on the premium
  min_premium_cents  bigint  not null check (min_premium_cents > 0),
  enabled            boolean not null default false,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references auth.users (id) on delete set null,
  check (not enabled or profit_rate_bps > 0)
);
insert into public.option_periods (duration_s, profit_rate_bps, fee_bps, min_premium_cents, enabled) values
  ( 30, 600, 10, 4900, true),
  ( 60,   0, 10, 4900, false),
  ( 90,   0, 10, 4900, false),
  (120,   0, 10, 4900, false),
  (300,   0, 10, 4900, false);

-- 3.2 options_positions. Times come from now() inside open_option.
create table public.options_positions (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profiles (id) on delete cascade,
  market_id          text not null references public.markets (id),
  direction          public.option_direction not null,
  duration_s         integer not null check (duration_s > 0),
  premium_cents      bigint not null check (premium_cents > 0),
  fee_cents          bigint not null check (fee_cents >= 0),
  profit_rate_bps    integer not null check (profit_rate_bps > 0),   -- snapshot of option_periods
  entry_price        numeric not null check (entry_price > 0 and entry_price <> 'NaN'::numeric),
  entry_price_at     timestamptz not null,                            -- fetched_at of the entry snapshot
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
                     and settle_price_at >= expires_at and settle_price_at <= expires_at + interval '60 seconds'
                     and settled_at is not null
                     and payout_cents = case result when 'loss' then 0
                                                    when 'draw' then premium_cents
                                                    else premium_cents + floor(premium_cents::numeric * profit_rate_bps / 10000)::bigint
                                        end
    when 'void' then result is null and settle_price is null and settle_price_at is null
                     and payout_cents = premium_cents + fee_cents and settled_at is not null
  end)
);
create index options_positions_due_idx on public.options_positions (market_id, expires_at) where status = 'open';
create index options_positions_user_created_idx on public.options_positions (user_id, created_at desc);

-- -----------------------------------------------------------------------------
-- 4. Private helpers (no client EXECUTE)
-- -----------------------------------------------------------------------------

-- 4.1 Settle the open positions of one market against one newly upserted
-- snapshot. Called by ingest_prices in the transaction that wrote the
-- snapshot, in ingest order, so each position settles at the first snapshot
-- inside its window. Returns the number settled.
create or replace function private.settle_options(p_market_id text, p_price numeric, p_fetched_at timestamptz)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids     uuid[];
  r         public.options_positions;
  v_result  public.option_result;
  v_profit  bigint;
  v_payout  bigint;
  v_wallet  uuid;
  v_n       integer := 0;
begin
  with c as (
    select p.id
      from public.options_positions p
     where p.market_id = p_market_id
       and p.status = 'open'
       and p.expires_at <= p_fetched_at
       and p.expires_at >= p_fetched_at - interval '60 seconds'
     order by p.expires_at, p.id
     limit 500
       for update of p skip locked
  )
  select array_agg(id order by id) into v_ids from c;
  if v_ids is null then return 0; end if;

  perform private.lock_wallets(array(
    select w.id from public.wallets w
      join public.options_positions p on p.user_id = w.user_id
     where p.id = any (v_ids) and w.account = 'options'));

  for r in select * from public.options_positions where id = any (v_ids) order by id loop
    v_profit := 0;
    if p_price = r.entry_price then
      v_result := 'draw';
      v_payout := r.premium_cents;
    elsif (r.direction = 'rise') = (p_price > r.entry_price) then
      v_result := 'win';
      v_profit := floor(r.premium_cents::numeric * r.profit_rate_bps / 10000);
      v_payout := r.premium_cents + v_profit;
    else
      v_result := 'loss';
      v_payout := 0;
    end if;

    update public.options_positions
       set status = 'settled', result = v_result, settle_price = p_price, settle_price_at = p_fetched_at,
           payout_cents = v_payout, settled_at = now()
     where id = r.id and status = 'open';
    if not found then continue; end if;

    select id into v_wallet from public.wallets where user_id = r.user_id and account = 'options';
    if v_result = 'win' then
      perform private.wallet_apply(v_wallet, v_payout, 0, 'option_settle', 'options_position', r.id,
                                   p_pnl_cents => v_profit);
    elsif v_result = 'loss' then
      perform private.wallet_apply(v_wallet, 0, 0, 'option_settle', 'options_position', r.id,
                                   p_pnl_cents => -r.premium_cents);
    else
      perform private.wallet_apply(v_wallet, v_payout, 0, 'option_refund', 'options_position', r.id);
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- 4.2 Void positions that found no settle price: still open more than 90 s
-- after expiry (O6). Run by pg_cron only. With nothing due it is one probe of
-- the small partial index of open positions.
create or replace function private.void_stale_options()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids     uuid[];
  r         public.options_positions;
  v_wallet  uuid;
  v_n       integer := 0;
begin
  with c as (
    select p.id
      from public.options_positions p
     where p.status = 'open'
       and p.expires_at < now() - interval '90 seconds'
     order by p.expires_at, p.id
     limit 500
       for update of p skip locked
  )
  select array_agg(id order by id) into v_ids from c;
  if v_ids is null then return 0; end if;

  perform private.lock_wallets(array(
    select w.id from public.wallets w
      join public.options_positions p on p.user_id = w.user_id
     where p.id = any (v_ids) and w.account = 'options'));

  for r in select * from public.options_positions where id = any (v_ids) order by id loop
    update public.options_positions
       set status = 'void', payout_cents = r.premium_cents + r.fee_cents, settled_at = now()
     where id = r.id and status = 'open';
    if not found then continue; end if;

    select id into v_wallet from public.wallets where user_id = r.user_id and account = 'options';
    perform private.wallet_apply(v_wallet, r.premium_cents + r.fee_cents, 0, 'option_refund',
                                 'options_position', r.id);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- 4.3 Price tick: the feed now also runs while any options position is open,
-- so a position keeps getting prices after its screen is closed.
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
  if not exists (select 1 from public.system_state where id and price_demand_until > now())
     and not exists (select 1 from public.options_positions where status = 'open') then
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

-- 5.1 open_option: no price argument. Idempotent on p_client_request_id: the
-- same key with the same parameters returns the first position's id; different
-- parameters raise IDEMPOTENCY_CONFLICT. Locks: the Options wallet only.
create or replace function public.open_option(
  p_market_id         text,
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
  v_uid     uuid := auth.uid();
  v_m       public.markets;
  v_p       public.option_periods;
  v_s       public.price_snapshots;
  v_wallet  public.wallets;
  v_fee     bigint;
  v_pos     public.options_positions;
begin
  if v_uid is null then raise exception 'UNAUTHENTICATED'; end if;
  if p_market_id is null or p_direction is null or p_duration_s is null
     or p_premium_cents is null or p_client_request_id is null then
    raise exception 'INVALID_ARGUMENT';
  end if;

  select * into v_wallet from public.wallets where user_id = v_uid and account = 'options';
  if not found then raise exception 'WALLET_NOT_FOUND'; end if;
  perform private.lock_wallets(array[v_wallet.id]);

  -- After the lock, so a concurrent call with the same key has committed.
  select * into v_pos from public.options_positions
   where user_id = v_uid and client_request_id = p_client_request_id;
  if found then
    if v_pos.market_id <> p_market_id or v_pos.direction <> p_direction
       or v_pos.duration_s <> p_duration_s or v_pos.premium_cents <> p_premium_cents then
      raise exception 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_pos.id;
  end if;

  select * into v_m from public.markets where id = p_market_id;
  if not found then raise exception 'MARKET_NOT_FOUND'; end if;
  if not (v_m.enabled and v_m.options_enabled) then raise exception 'MARKET_DISABLED'; end if;

  select * into v_p from public.option_periods where duration_s = p_duration_s;
  if not found then raise exception 'PERIOD_NOT_FOUND'; end if;
  if not v_p.enabled or v_p.profit_rate_bps <= 0 then raise exception 'PERIOD_DISABLED'; end if;
  if p_premium_cents < v_p.min_premium_cents then
    raise exception 'BELOW_MIN_PREMIUM' using detail = format('min_cents=%s', v_p.min_premium_cents);
  end if;

  -- Entry price (O5): the snapshot mid, at most 15 s old.
  select * into v_s from public.price_snapshots s
   where s.market_id = p_market_id
     and s.fetched_at > now() - interval '15 seconds'
     and s.fetched_at <= now();
  if not found then raise exception 'PRICE_STALE'; end if;

  v_fee := ceil(p_premium_cents * v_p.fee_bps / 10000.0);

  select * into v_wallet from public.wallets where id = v_wallet.id;
  if v_wallet.available_cents < p_premium_cents + v_fee then
    raise exception 'INSUFFICIENT_FUNDS'
      using detail = format('available=%s required=%s', v_wallet.available_cents, p_premium_cents + v_fee);
  end if;

  insert into public.options_positions (user_id, market_id, direction, duration_s, premium_cents, fee_cents,
                                        profit_rate_bps, entry_price, entry_price_at, created_at, expires_at,
                                        client_request_id)
  values (v_uid, p_market_id, p_direction, p_duration_s, p_premium_cents, v_fee,
          v_p.profit_rate_bps, (v_s.bid + v_s.ask) / 2, v_s.fetched_at, now(),
          now() + make_interval(secs => p_duration_s), p_client_request_id)
  returning * into v_pos;

  perform private.wallet_apply(v_wallet.id, -p_premium_cents, 0, 'option_premium', 'options_position', v_pos.id);
  if v_fee > 0 then
    perform private.wallet_apply(v_wallet.id, -v_fee, 0, 'fee', 'options_position', v_pos.id);
  end if;
  return v_pos.id;
end;
$$;

-- 5.2 server_time: the client's countdown offset (expiry is server time).
create or replace function public.server_time()
returns timestamptz
language sql
stable
set search_path = ''
as $$ select now(); $$;

-- -----------------------------------------------------------------------------
-- 6. Admin RPC: same checks as admin_adjust_balance (claim, aal2, live role).
-- Updates one existing period; open positions keep the rate copied at open.
-- -----------------------------------------------------------------------------
create or replace function public.admin_set_option_period(
  p_duration_s         integer,
  p_profit_rate_bps    integer,
  p_fee_bps            integer,
  p_min_premium_cents  bigint,
  p_enabled            boolean
)
returns public.option_periods
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin uuid := auth.uid();
  v_p     public.option_periods;
begin
  if v_admin is null then raise exception 'UNAUTHENTICATED'; end if;
  if coalesce(auth.jwt() ->> 'user_role', '') <> 'admin' then raise exception 'FORBIDDEN'; end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then raise exception 'AAL2_REQUIRED'; end if;
  if not private.is_admin() then raise exception 'FORBIDDEN'; end if;

  if p_duration_s is null or p_enabled is null
     or p_profit_rate_bps is null or p_profit_rate_bps not between 0 and 100000
     or p_fee_bps is null or p_fee_bps not between 0 and 1000
     or p_min_premium_cents is null or p_min_premium_cents <= 0
     or (p_enabled and p_profit_rate_bps = 0) then
    raise exception 'INVALID_ARGUMENT';
  end if;

  update public.option_periods
     set profit_rate_bps = p_profit_rate_bps, fee_bps = p_fee_bps, min_premium_cents = p_min_premium_cents,
         enabled = p_enabled, updated_at = now(), updated_by = v_admin
   where duration_s = p_duration_s
  returning * into v_p;
  if not found then raise exception 'PERIOD_NOT_FOUND'; end if;

  insert into public.admin_audit_log (admin_id, action, payload)
  values (v_admin, 'set_option_period', to_jsonb(v_p));
  return v_p;
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. ingest_prices: unchanged validation and forward-only upsert. Each written
-- snapshot of an options market then settles that market's due positions at
-- its mid, in ingest order, in this transaction. Returns settled as well.
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
  v_ign  integer := 0;   -- valid, but not newer than the stored snapshot
  v_set  integer := 0;   -- options positions settled
  v_mk   text[] := '{}';         -- written snapshots of options markets, in order
  v_mid  numeric[] := '{}';
  v_at   timestamptz[] := '{}';
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
      if found then
        v_ok := v_ok + 1;
        if v_m.options_enabled then
          v_mk := v_mk || v_m.id; v_mid := v_mid || ((v_bid + v_ask) / 2); v_at := v_at || v_ts;
        end if;
      else
        v_ign := v_ign + 1;
      end if;
    exception
      when raise_exception or invalid_text_representation or invalid_datetime_format
           or datetime_field_overflow or numeric_value_out_of_range or check_violation then
        v_rej := v_rej + 1;
    end;
  end loop;

  for i in 1 .. coalesce(array_length(v_mk, 1), 0) loop
    v_set := v_set + private.settle_options(v_mk[i], v_mid[i], v_at[i]);
  end loop;
  return jsonb_build_object('accepted', v_ok, 'rejected', v_rej, 'ignored', v_ign, 'settled', v_set);
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. Row Level Security and grants
-- -----------------------------------------------------------------------------
alter table public.option_periods    enable row level security;
alter table public.options_positions enable row level security;

create policy option_periods_select on public.option_periods for select to authenticated using (true);
create policy options_positions_select on public.options_positions for select to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.option_periods, public.options_positions from anon, authenticated;
grant select on public.option_periods, public.options_positions to authenticated;

revoke all on function private.settle_options(text, numeric, timestamptz) from public, anon, authenticated;
revoke all on function private.void_stale_options()                       from public, anon, authenticated;
revoke all on function public.open_option(text, public.option_direction, integer, bigint, uuid) from public, anon;
revoke all on function public.server_time()                               from public, anon;
revoke all on function public.admin_set_option_period(integer, integer, integer, bigint, boolean) from public, anon;

-- price_tick and ingest_prices keep their grants (CREATE OR REPLACE keeps them).
grant execute on function public.open_option(text, public.option_direction, integer, bigint, uuid) to authenticated;
grant execute on function public.server_time() to authenticated;
grant execute on function public.admin_set_option_period(integer, integer, integer, bigint, boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- 9. Realtime: positions (own rows, RLS per subscriber) and period changes.
-- -----------------------------------------------------------------------------
alter publication supabase_realtime add table public.options_positions, public.option_periods;

-- -----------------------------------------------------------------------------
-- 10. Schedule: the void job, SQL only (never the Edge Function).
-- -----------------------------------------------------------------------------
select cron.schedule('aureonx-options-void', '10 seconds', $c$ select private.void_stale_options(); $c$);
