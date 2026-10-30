-- =============================================================================
-- Forex price feed: at most one Open Exchange Rates call per clock hour (UTC),
-- only while someone is on a Forex screen or a Forex position is pending or
-- open, and never while both Forex classes are closed. The same shape as the
-- crypto feed: pg_cron aureonx-fx-tick (every minute) -> private.fx_tick ->
-- pg_net post -> Edge Function fx-ingest -> public.ingest_fx_rates.
--
-- Owner decisions:
--   * Demand: request_fx_feed() (a Forex screen heartbeat, throttled to one
--     accepted call per user per 30 s) extends demand to now + 5 min. A pending
--     or open fx_positions row is demand too.
--   * Both classes closed (private.fx_is_closed): no call. One class closed: call,
--     since one table prices every instrument.
--   * Hourly slot: claimed by one conditional UPDATE on fx_state, never before
--     minute SLOT_MIN_MINUTE (5) of the hour. A claimed slot is spent even when
--     the call fails. No retries: the next hour tries again. The slot is the
--     call's negative cache.
--   * Monthly cap: claims per calendar month (UTC) stop at MONTH_CAP (950), below
--     the 1,000 call plan. A blocked hour logs one warning and is marked spent.
--   * The app id is the Edge Function secret OXR_APP_ID and never reaches the
--     database. pg_net authenticates to fx-ingest with the shared secret in
--     Vault (fx_ingest_secret), as price-ingest and kyc-cleanup do.
-- The crypto feed and the Forex money functions are unchanged.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. State: one row, not readable over the API.
-- -----------------------------------------------------------------------------
create table public.fx_state (
  id                boolean primary key default true check (id),
  slot_hour         timestamptz,   -- the last claimed clock hour (UTC)
  demand_until      timestamptz,   -- Forex screen demand window end
  month_key         text check (month_key ~ '^[0-9]{4}-[0-9]{2}$'),   -- 'YYYY-MM' (UTC) of month_calls
  month_calls       integer not null default 0 check (month_calls >= 0),
  last_http_status  integer,       -- null when the call got no response (timeout, network)
  last_call_at      timestamptz,
  last_print_ts     timestamptz    -- ts of the last table ingest_fx_rates accepted
);
insert into public.fx_state default values;

alter table public.fx_state enable row level security;
revoke all on public.fx_state from anon, authenticated;

-- Throttle column for request_fx_feed (no client reads or writes it).
alter table public.profiles add column fx_feed_requested_at timestamptz;

-- -----------------------------------------------------------------------------
-- 2. Market hours: the end of the current closure, null when p_at is open.
-- fx reopens Sunday 17:00 New York; metal reopens 18:00 Sunday to Thursday.
-- -----------------------------------------------------------------------------
create or replace function private.fx_next_open(p_class public.fx_class, p_at timestamptz)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select case when private.fx_is_closed(p_class, p_at) then (
    select min(c.at)
      from generate_series(0, 7) i,
           lateral (select ((p_at at time zone 'America/New_York')::date + i)
                           + case p_class when 'fx' then time '17:00' else time '18:00' end as local_at) l,
           lateral (select l.local_at at time zone 'America/New_York' as at) c
     where c.at > p_at
       and (extract(isodow from l.local_at) = 7
            or (p_class = 'metal' and extract(isodow from l.local_at) between 1 and 4))
  ) end;
$$;

-- For both classes: closed, opens_at (end of the current closure, null when
-- open) and closes_at (the next closure start; while closed, the one after the
-- reopening). Timestamps in UTC; the client formats them in New York time.
create or replace function private.fx_market_status(p_at timestamptz)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_object_agg(k.c, jsonb_build_object(
           'closed', s.closed,
           'opens_at', s.opens_at,
           'closes_at', private.fx_next_close(k.c::public.fx_class, coalesce(s.opens_at, p_at))))
    from (values ('fx'), ('metal')) k(c),
         lateral (select private.fx_is_closed(k.c::public.fx_class, p_at) closed,
                         private.fx_next_open(k.c::public.fx_class, p_at) opens_at) s;
$$;

-- -----------------------------------------------------------------------------
-- 3. The tick. Returns what it did (for tests and logs): early, closed,
-- no_demand, taken, capped, not_configured or called.
-- -----------------------------------------------------------------------------
create or replace function private.fx_tick(p_at timestamptz default now())
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- SLOT_MIN_MINUTE: the table for hour H is published at H:00; claim from H:05.
  c_slot_min_minute constant integer := 5;
  -- MONTH_CAP: calls per calendar month (UTC), below the 1,000 call plan.
  c_month_cap       constant integer := 950;
  v_hour   timestamptz := date_trunc('hour', p_at, 'UTC');
  v_month  text := to_char(p_at at time zone 'UTC', 'YYYY-MM');
  v_url    text;
  v_secret text;
begin
  if extract(minute from p_at at time zone 'UTC') < c_slot_min_minute then return 'early'; end if;
  if private.fx_is_closed('fx', p_at) and private.fx_is_closed('metal', p_at) then return 'closed'; end if;
  if not exists (select 1 from public.fx_state where id and demand_until > p_at)
     and not exists (select 1 from public.fx_positions where status in ('pending', 'open')) then
    return 'no_demand';
  end if;

  -- Claim the hour: only one tick per hour gets the row, and only under the cap.
  update public.fx_state
     set slot_hour = v_hour,
         month_calls = case when month_key = v_month then month_calls + 1 else 1 end,
         month_key = v_month
   where id
     and (slot_hour is null or slot_hour < v_hour)
     and (month_key is distinct from v_month or month_calls < c_month_cap);
  if not found then
    -- The cap blocks this hour: mark it spent so the warning is logged once per hour.
    update public.fx_state set slot_hour = v_hour
     where id and (slot_hour is null or slot_hour < v_hour);
    if found then
      raise warning 'aureonx fx_tick: monthly cap of % calls reached for %', c_month_cap, v_month;
      return 'capped';
    end if;
    return 'taken';
  end if;

  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'fx_ingest_secret';
  if v_url is null or v_secret is null then
    raise log 'aureonx fx_tick: vault secrets project_url / fx_ingest_secret missing';
    return 'not_configured';
  end if;

  perform net.http_post(
    url                  := v_url || '/functions/v1/fx-ingest',
    headers              := jsonb_build_object('Content-Type', 'application/json',
                                               'x-region', 'eu-west-1',
                                               'x-aureonx-cron-secret', v_secret),
    body                 := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
  return 'called';
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. RPCs
-- -----------------------------------------------------------------------------

-- 4.1 request_fx_feed: a visible Forex screen calls this on mount and as a
-- heartbeat. One accepted call per user per 30 s extends demand to now + 5 min;
-- a throttled call changes nothing. Always returns the demand end and the
-- market status of both classes.
create or replace function public.request_fx_feed()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED'; end if;

  update public.profiles
     set fx_feed_requested_at = now()
   where id = auth.uid()
     and (fx_feed_requested_at is null or fx_feed_requested_at <= now() - interval '30 seconds');
  if found then
    update public.fx_state
       set demand_until = greatest(coalesce(demand_until, now()), now() + interval '5 minutes')
     where id;
  end if;

  return private.fx_market_status(now())
         || jsonb_build_object('demand_until', (select demand_until from public.fx_state where id));
end;
$$;

-- 4.2 fx_record_call (service_role only): fx-ingest records each call's HTTP
-- status (null without a response), the call time and, after a good ingest, the
-- table ts.
create or replace function public.fx_record_call(p_status integer, p_print_ts timestamptz default null)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.fx_state
     set last_http_status = p_status, last_call_at = now(),
         last_print_ts = coalesce(p_print_ts, last_print_ts)
   where id;
$$;

-- -----------------------------------------------------------------------------
-- 5. Grants
-- -----------------------------------------------------------------------------
revoke all on function private.fx_next_open(public.fx_class, timestamptz) from public, anon, authenticated;
revoke all on function private.fx_market_status(timestamptz)              from public, anon, authenticated;
revoke all on function private.fx_tick(timestamptz)                       from public, anon, authenticated;
revoke all on function public.request_fx_feed()                           from public, anon;
revoke all on function public.fx_record_call(integer, timestamptz)        from public, anon, authenticated;
grant execute on function public.request_fx_feed() to authenticated;
grant execute on function public.fx_record_call(integer, timestamptz) to service_role;

-- -----------------------------------------------------------------------------
-- 6. Schedule: every minute; fx_tick decides whether this minute calls.
-- -----------------------------------------------------------------------------
select cron.schedule('aureonx-fx-tick', '* * * * *', $c$ select private.fx_tick(); $c$);
