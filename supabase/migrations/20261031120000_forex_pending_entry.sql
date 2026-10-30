-- =============================================================================
-- Forex pending entry. Replaces the entry rule of 20261031100100_forex_money:
-- a position no longer enters at the newest stored print (which can be up to an
-- hour old while the user watches a live chart). It opens as 'pending' and takes
-- as its entry the first fx_prices row with ts >= created_at + ENTRY_GUARD.
--
-- Owner decisions:
--   * open_fx_position debits premium and fee as before and inserts the position
--     as 'pending' with no entry price, entry time or expiry. The newest print
--     must still be at most 70 minutes old and not in the future (PRICE_STALE),
--     as a feed-health guard only. No cancel while pending.
--   * Entry: ingest_fx_rates, before settlement, gives every pending position of
--     each instrument it wrote the first print with created_at + ENTRY_GUARD
--     (5 minutes) <= ts <= created_at + ENTRY_WAIT_MAX (65 minutes), judged on the
--     print's own ts: entry_price, entry_price_at (that ts), expires_at =
--     entry_price_at + duration_s, status 'open'. A position with no print in that
--     window stays pending until the void. No money moves and no wallet is locked
--     in this step.
--   * Settle (unchanged): the first print with expires_at <= ts <= expires_at +
--     2 h and ts > entry_price_at, compared at price_decimals.
--   * Void: pending with no entry by created_at + 2 h 20 min or open with no
--     settle print by expires_at + 2 h 15 min. Both refund premium + fee with PnL
--     +fee, so a void nets 0.
--   * Closure at open: refused (MARKET_CLOSED, DETAIL closes_before_expiry) when
--     now + ENTRY_WAIT_MAX + duration + SETTLE_MARGIN falls after the next
--     closure start. ENTRY_WAIT_MAX = ENTRY_GUARD + 60 min, SETTLE_MARGIN = 70 min.
--
-- Status: fx_positions gets its own enum fx_position_status (pending, open,
-- settled, void), so the crypto Options enum option_status and its table stay
-- unchanged. pending -> open -> settled (win, loss or draw) or void; pending ->
-- void. The table holds no rows when this runs (checked below).
--
-- Locks: open_fx_position locks the forex wallet only. ingest_fx_rates takes the
-- instrument rows (FOR NO KEY UPDATE), then the pending rows it assigns (a plain
-- UPDATE, which waits for a void in progress and then skips the row because it is
-- no longer pending), then every wallet it pays, once and ascending, then the due
-- positions (SKIP LOCKED). void_stale_fx locks positions (SKIP LOCKED), then
-- wallets ascending. Nothing locks a position after a wallet without SKIP LOCKED,
-- so the three never wait on each other in a cycle.
-- =============================================================================

do $$
begin
  if exists (select 1 from public.fx_positions) then
    raise exception 'forex_pending_entry: fx_positions is not empty';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 1. ENTRY_GUARD and ENTRY_WAIT_MAX: the one definition of each, used by the
-- CHECK, open_fx_position (closure rule) and ingest_fx_rates (entry window).
-- ENTRY_WAIT_MAX is ENTRY_GUARD plus one print interval (60 minutes).
-- -----------------------------------------------------------------------------
create or replace function private.fx_entry_guard()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '5 minutes' $$;

create or replace function private.fx_entry_wait_max()
returns interval
language sql
immutable
set search_path = ''
as $$ select private.fx_entry_guard() + interval '60 minutes' $$;

-- -----------------------------------------------------------------------------
-- 2. fx_positions: own status enum, nullable entry columns and expiry, new CHECKs.
-- -----------------------------------------------------------------------------
create type public.fx_position_status as enum ('pending', 'open', 'settled', 'void');

drop index public.fx_positions_due_idx;
alter table public.fx_positions
  drop constraint fx_positions_check,     -- entry_price_at <= created_at
  drop constraint fx_positions_check1,    -- expires_at = created_at + duration_s
  drop constraint fx_positions_check2;    -- the status CHECK
alter table public.fx_positions
  alter column status drop default,
  alter column status type public.fx_position_status using status::text::public.fx_position_status,
  alter column status set default 'pending',
  alter column entry_price drop not null,
  alter column entry_price_at drop not null,
  alter column expires_at drop not null;

-- The entry columns and expires_at are set together; the entry print lies in
-- [created_at + ENTRY_GUARD, created_at + ENTRY_WAIT_MAX] and the expiry follows it.
alter table public.fx_positions add constraint fx_positions_entry_check check (
  num_nulls(entry_price, entry_price_at, expires_at) in (0, 3)
  and (entry_price_at is null
       or (entry_price_at >= created_at + private.fx_entry_guard()
           and entry_price_at <= created_at + private.fx_entry_wait_max()
           and expires_at = entry_price_at + make_interval(secs => duration_s)))
);

alter table public.fx_positions add constraint fx_positions_status_check check (case status
  when 'pending' then entry_price is null and entry_price_at is null and expires_at is null
                   and result is null and settle_price is null and settle_price_at is null
                   and payout_cents is null and settled_at is null
  when 'open' then entry_price is not null and entry_price_at is not null and expires_at is not null
                   and result is null and settle_price is null and settle_price_at is null
                   and payout_cents is null and settled_at is null
  when 'settled' then entry_price is not null and entry_price_at is not null and expires_at is not null
                   and result is not null and settle_price is not null and settle_price_at is not null
                   and payout_cents is not null and settled_at is not null
                   and settle_price > 0 and settle_price <> 'NaN'::numeric
                   and settle_price_at >= expires_at and settle_price_at <= expires_at + interval '2 hours'
                   and settle_price_at > entry_price_at
                   and settled_at >= settle_price_at
                   and payout_cents = case result when 'loss' then 0
                                                  when 'draw' then premium_cents
                                                  else premium_cents + floor(premium_cents::numeric * profit_rate_bps / 10000)::bigint
                                      end
  -- A void from pending has no entry; a void from open has one.
  when 'void' then result is null and settle_price is null and settle_price_at is null
                   and payout_cents is not null and settled_at is not null
                   and payout_cents = premium_cents + fee_cents
                   and case when entry_price is null then settled_at > created_at + interval '2 hours 20 minutes'
                            else settled_at > expires_at + interval '2 hours 15 minutes' end
  else false
end);

create index fx_positions_due_idx on public.fx_positions (instrument_id, expires_at) where status = 'open';
create index fx_positions_pending_idx on public.fx_positions (instrument_id, created_at) where status = 'pending';

-- -----------------------------------------------------------------------------
-- 3. void_stale_fx: pending past created_at + 2 h 20 min or open past
-- expires_at + 2 h 15 min. Premium and fee refunded; the refund carries PnL +fee.
-- -----------------------------------------------------------------------------
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
     where (p.status = 'open' and p.expires_at < now() - interval '2 hours 15 minutes')
        or (p.status = 'pending' and p.created_at < now() - interval '2 hours 20 minutes')
     order by p.created_at, p.id
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
     where id = r.id and status = r.status and status in ('pending', 'open');
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
-- 4. open_fx_position: the same checks in the same order; the position is
-- pending with no entry. Idempotent on p_client_request_id as before.
-- -----------------------------------------------------------------------------
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
  -- Feed health: the newest print must be at most this old (it is not the entry).
  c_max_print_age   constant interval := interval '70 minutes';
  -- ENTRY_WAIT_MAX: the latest entry print, created_at + 65 min.
  c_entry_wait_max  constant interval := private.fx_entry_wait_max();
  -- SETTLE_MARGIN: the settle print can land up to one print interval (60 min)
  -- plus the fetch margin (10 min) after expiry.
  c_settle_margin   constant interval := interval '70 minutes';
  v_uid     uuid := auth.uid();
  v_i       public.fx_instruments;
  v_p       public.fx_periods;
  v_px      public.fx_prices;
  v_wallet  public.wallets;
  v_fee     bigint;
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

  -- The whole life (entry wait, duration, settle margin) must end before the next closure.
  if private.fx_is_closed(v_i.class, now()) then raise exception 'MARKET_CLOSED'; end if;
  if now() + c_entry_wait_max + make_interval(secs => p_duration_s) + c_settle_margin
     > private.fx_next_close(v_i.class, now()) then
    raise exception 'MARKET_CLOSED' using detail = 'closes_before_expiry';
  end if;

  select * into v_px from public.fx_prices
   where instrument_id = p_instrument_id
   order by ts desc
   limit 1;
  if not found or v_px.ts <= now() - c_max_print_age or v_px.ts > now() then
    raise exception 'PRICE_STALE';
  end if;

  v_fee := ceil(p_premium_cents * v_p.fee_bps / 10000.0);

  select * into v_wallet from public.wallets where id = v_wallet.id;
  if v_wallet.available_cents < p_premium_cents + v_fee then
    raise exception 'INSUFFICIENT_FUNDS'
      using detail = format('available=%s required=%s', v_wallet.available_cents, p_premium_cents + v_fee);
  end if;

  insert into public.fx_positions (user_id, instrument_id, direction, duration_s, premium_cents, fee_cents,
                                   profit_rate_bps, created_at, status, client_request_id)
  values (v_uid, p_instrument_id, p_direction, p_duration_s, p_premium_cents, v_fee,
          v_p.profit_rate_bps, now(), 'pending', p_client_request_id)
  returning * into v_pos;

  perform private.wallet_apply(v_wallet.id, -p_premium_cents, 0, 'forex_margin', 'forex_position', v_pos.id);
  if v_fee > 0 then
    perform private.wallet_apply(v_wallet.id, -v_fee, 0, 'fee', 'forex_position', v_pos.id,
                                 p_pnl_cents => -v_fee);
  end if;
  return v_pos.id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. ingest_fx_rates: as before, plus the entry step between writing the prices
-- and settling. Returns entered (positions that took an entry) as well.
-- -----------------------------------------------------------------------------
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
  v_ent      integer := 0;   -- pending positions that took an entry
  v_set      integer := 0;   -- positions settled
  v_err      integer := 0;   -- instruments whose settlement failed (price still written)
  v_batch    integer;
  v_skipped  text[] := '{}';
  v_ids      text[] := '{}';         -- written prices, in order
  v_prices   numeric[] := '{}';
begin
  begin
    v_body := p_body::jsonb;
  exception when others then
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

  -- Entry: each pending position of an instrument written here takes the first
  -- print with ts in [created_at + ENTRY_GUARD, created_at + ENTRY_WAIT_MAX], on the
  -- print's own ts. None in the window: it stays pending for the void job.
  -- No money moves; no wallet lock.
  with e as (
    select p.id, x.price, x.ts
      from public.fx_positions p
      cross join lateral (
        select f.price, f.ts from public.fx_prices f
         where f.instrument_id = p.instrument_id and f.ts >= p.created_at + private.fx_entry_guard()
           and f.ts <= p.created_at + private.fx_entry_wait_max()
         order by f.ts
         limit 1) x
     where p.instrument_id = any (v_ids) and p.status = 'pending'
  )
  update public.fx_positions p
     set status = 'open', entry_price = e.price, entry_price_at = e.ts,
         expires_at = e.ts + make_interval(secs => p.duration_s)
    from e
   where p.id = e.id and p.status = 'pending';
  get diagnostics v_ent = row_count;

  -- Lock the forex wallets of every position this table settles once, ascending,
  -- before any settle_fx call. Locking them per instrument would take them out of
  -- order across instruments and could deadlock with void_stale_fx.
  perform private.lock_wallets(array(
    select distinct w.id from public.fx_positions p
      join public.wallets w on w.user_id = p.user_id and w.account = 'forex'
     where p.instrument_id = any (v_ids) and p.status = 'open'
       and p.expires_at <= v_ts and p.expires_at >= v_ts - interval '2 hours'));

  -- Each instrument settles in its own subtransaction: a failure rolls back only
  -- that instrument's settlement, never the prices or the entries. Its due
  -- positions are retried by the next price in the window, else voided by the
  -- void job. Batches repeat until one comes back short, so every due position
  -- settles at this price (the next price is an hour away).
  for n in 1 .. coalesce(array_length(v_ids, 1), 0) loop
    begin
      loop
        v_batch := private.settle_fx(v_ids[n], v_prices[n], v_ts);
        v_set := v_set + v_batch;
        exit when v_batch < 500;
      end loop;
    exception when others then
      v_err := v_err + 1;
      raise warning 'aureonx settle_fx failed for %: %', v_ids[n], sqlerrm;
    end;
  end loop;
  return jsonb_build_object('ts', v_ts, 'accepted', v_ok, 'ignored', v_ign, 'skipped', to_jsonb(v_skipped),
                            'entered', v_ent, 'settled', v_set, 'settle_errors', v_err);
end;
$$;

revoke all on function private.fx_entry_guard() from public, anon, authenticated;
revoke all on function private.fx_entry_wait_max() from public, anon, authenticated;
