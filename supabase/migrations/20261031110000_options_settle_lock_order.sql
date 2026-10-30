-- =============================================================================
-- Options settlement lock order. Replaces public.ingest_prices only; signature,
-- grants, amounts and every other rule are unchanged.
--
--   1. Lock order. settle_options locked each market's wallets ascending, so one
--      ingest took them market by market: ascending inside a market, out of
--      order across markets. void_stale_options locks its wallets ascending in
--      one statement. An ingest holding a high wallet from market A and waiting
--      for a low one from market B could deadlock with a void holding the low
--      one; the deadlock aborted that market's settlement subtransaction and its
--      positions waited for a later snapshot. ingest_prices now locks the
--      options wallets of every position it settles once, ascending, before any
--      settle_options call (as ingest_fx_rates does), so every taker of more
--      than one wallet locks in ascending order. settle_options and
--      void_stale_options are unchanged; the lock_wallets call inside
--      settle_options then only meets wallets this transaction already holds.
--   2. More than 500 due positions. settle_options settles at most 500 per call
--      and ingest_prices called it once per market, so the rest settled at a
--      later snapshot. ingest_prices now repeats the call until a batch comes
--      back short, so every due position settles at the first snapshot in its
--      window.
-- =============================================================================

create or replace function public.ingest_prices(p_prices jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  e        jsonb;
  v_m      public.markets;
  v_bid    numeric;
  v_ask    numeric;
  v_ts     timestamptz;
  v_ok     integer := 0;
  v_rej    integer := 0;
  v_ign    integer := 0;   -- valid, but not newer than the stored snapshot
  v_set    integer := 0;   -- options positions settled
  v_err    integer := 0;   -- markets whose settlement failed (snapshot still written)
  v_batch  integer;
  v_mk     text[] := '{}';         -- written snapshots of options markets, in order
  v_mid    numeric[] := '{}';
  v_at     timestamptz[] := '{}';
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

  -- Lock the options wallets of every position these snapshots settle once,
  -- ascending, before any settle_options call (see the header). The window is
  -- settle_options' own, per written snapshot.
  perform private.lock_wallets(array(
    select distinct w.id
      from unnest(v_mk, v_at) as s(market_id, fetched_at)
      join public.options_positions p
        on p.market_id = s.market_id and p.status = 'open'
       and p.expires_at <= s.fetched_at and p.expires_at >= s.fetched_at - interval '60 seconds'
      join public.wallets w on w.user_id = p.user_id and w.account = 'options'));

  -- Each market settles in its own subtransaction: a failure rolls back only
  -- that market's settlement, never the snapshots. Its due positions are
  -- retried by the next snapshot in the window, else voided by the void job.
  -- Batches repeat until one comes back short, so every due position settles at
  -- this snapshot.
  for i in 1 .. coalesce(array_length(v_mk, 1), 0) loop
    begin
      loop
        v_batch := private.settle_options(v_mk[i], v_mid[i], v_at[i]);
        v_set := v_set + v_batch;
        exit when v_batch < 500;
      end loop;
    exception when others then
      v_err := v_err + 1;
      raise warning 'aureonx settle_options failed for %: %', v_mk[i], sqlerrm;
    end;
  end loop;
  return jsonb_build_object('accepted', v_ok, 'rejected', v_rej, 'ignored', v_ign,
                            'settled', v_set, 'settle_errors', v_err);
end;
$$;
