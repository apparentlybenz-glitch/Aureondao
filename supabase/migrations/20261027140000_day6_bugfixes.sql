-- =============================================================================
-- Day 6 bug pass (audit items 16 to 21). Applied through the Management API.
--   16. open_option rejects p_premium_cents above 100000000000 (INVALID_AMOUNT),
--       before the bigint fee math can overflow. Not a product maximum.
--   17. spot_market_order looks up the idempotency key before validating, so a
--       replay returns the original order even if the market was disabled since.
--   18. request_price_feed throttle: profiles.price_feed_requested_at. A call
--       within 30 s of the caller's last accepted call returns the current
--       window end without touching demand and without an error. The client
--       heartbeat is 60 s, so it never hits the throttle.
--   19. ledger_id_seq is no longer usable by anon or authenticated (every ledger
--       insert runs inside a SECURITY DEFINER function). profiles leaves the
--       Realtime publication: no client subscribes to it.
--   20. Indexes for the foreign keys on orders and transfers.
-- Signatures and grants of the three functions are unchanged.
-- =============================================================================

-- 18. Throttle column, private to the throttle (no client reads or writes it).
alter table public.profiles add column if not exists price_feed_requested_at timestamptz;

create or replace function public.request_price_feed()
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED'; end if;

  -- Claim the slot atomically: only a caller whose last accepted call is older
  -- than 30 s (or who never called) updates the row and moves the window.
  update public.profiles
     set price_feed_requested_at = now()
   where id = auth.uid()
     and (price_feed_requested_at is null or price_feed_requested_at <= now() - interval '30 seconds');
  if not found then
    -- Throttled: report the current window end, change nothing.
    return (select price_demand_until from public.system_state where id);
  end if;
  return private.touch_price_demand();
end;
$$;

-- 16. open_option (body as in 20261026183757 plus the cap).
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
  -- Overflow guard (bigint math below), the same cap as admin_adjust_balance.
  -- Not a product maximum: the wallet balance is the real limit.
  if p_premium_cents > 100000000000 then raise exception 'INVALID_AMOUNT'; end if;

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

-- 17. spot_market_order (body as in 20261026130512 with the replay lookup moved).
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

  v_qty := private.parse_decimal(p_qty);

  select * into v_wallet from public.wallets where user_id = v_uid and account = 'spot';
  if not found then raise exception 'WALLET_NOT_FOUND'; end if;
  perform private.lock_wallets(array[v_wallet.id]);
  v_h := private.lock_holding(v_uid, v_m.base);

  -- Replay first, after the locks (a concurrent call with the same key has
  -- committed): a retry returns the original order even if the market has since
  -- been disabled. Validation only applies to a new order.
  select * into v_o from public.orders
   where user_id = v_uid and client_request_id = p_client_request_id;
  if found then
    if v_o.market_id <> p_market_id or v_o.side <> p_side or v_o.qty <> v_qty then
      raise exception 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_o;
  end if;

  if not v_m.enabled then raise exception 'MARKET_DISABLED'; end if;
  if v_qty <= 0 then raise exception 'INVALID_QTY'; end if;
  if v_qty <> trunc(v_qty, v_m.qty_decimals) then
    raise exception 'INVALID_QTY' using detail = format('max_decimals=%s', v_m.qty_decimals);
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

-- 19. Sequence and publication hygiene.
revoke all on sequence public.ledger_id_seq from anon, authenticated;
alter default privileges for role postgres revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter publication supabase_realtime drop table public.profiles;

-- 20. Foreign key indexes (cascade deletes and joins on the two tables).
create index if not exists orders_wallet_market_idx on public.orders (wallet_id, market_id);
create index if not exists transfers_from_to_wallet_idx on public.transfers (from_wallet_id, to_wallet_id);
