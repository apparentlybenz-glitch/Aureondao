-- =============================================================================
-- Slice 5 Part A follow-ups (owner review of 20261026182324_options_settlement).
-- Applied through the Management API. Replaces three functions; signatures,
-- grants and every other rule are unchanged.
--   1. ingest_prices: each market's settlement runs in its own subtransaction.
--      An error is logged (RAISE WARNING) and counted in settle_errors; the
--      snapshot upserts always commit, so a settlement bug never stops prices.
--   2. Options fees count in realized PnL, as Spot sell fees do: the fee row at
--      open carries pnl -fee and a void's refund carries pnl +fee (a void nets
--      0, a draw nets -fee). Win, loss and draw settle rows are unchanged.
--      Per position, sum(pnl) = payout - premium - fee once it is closed.
-- =============================================================================

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
    perform private.wallet_apply(v_wallet.id, -v_fee, 0, 'fee', 'options_position', v_pos.id,
                                 p_pnl_cents => -v_fee);
  end if;
  return v_pos.id;
end;
$$;

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
                                 'options_position', r.id, p_pnl_cents => r.fee_cents);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

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
  v_err  integer := 0;   -- markets whose settlement failed (snapshot still written)
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

  -- Each market settles in its own subtransaction: a failure rolls back only
  -- that market's settlement, never the snapshots. Its due positions are
  -- retried by the next snapshot in the window, else voided by the void job.
  for i in 1 .. coalesce(array_length(v_mk, 1), 0) loop
    begin
      v_set := v_set + private.settle_options(v_mk[i], v_mid[i], v_at[i]);
    exception when others then
      v_err := v_err + 1;
      raise warning 'aureonx settle_options failed for %: %', v_mk[i], sqlerrm;
    end;
  end loop;
  return jsonb_build_object('accepted', v_ok, 'rejected', v_rej, 'ignored', v_ign,
                            'settled', v_set, 'settle_errors', v_err);
end;
$$;
