-- =============================================================================
-- Slice 4 fix: ingest_prices counted a valid price that the forward-only upsert
-- did not write (its timestamp was not newer than the stored snapshot) as
-- "accepted". It now reports those as "ignored". Replaces this function only;
-- signature, grants and behaviour are otherwise unchanged. Applied through the
-- Management API.
-- =============================================================================
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
      if found then v_ok := v_ok + 1; else v_ign := v_ign + 1; end if;
    exception
      when raise_exception or invalid_text_representation or invalid_datetime_format
           or datetime_field_overflow or numeric_value_out_of_range or check_violation then
        v_rej := v_rej + 1;
    end;
  end loop;
  return jsonb_build_object('accepted', v_ok, 'rejected', v_rej, 'ignored', v_ign);
end;
$$;
