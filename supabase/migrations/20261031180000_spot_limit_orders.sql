-- =============================================================================
-- Spot limit orders (slice 4 Part C). Database only; no screen calls it yet.
-- Design: docs/data-model.md §16.4, with the owner's choices:
--   * A resting order fills at its limit price, so its hold is exact:
--     held - cost - fee = 0 for a buy, held_qty - qty = 0 for a sell.
--   * A limit that is marketable at placement fills at once at the fresh
--     snapshot ask (buy) or bid (sell), never worse than the limit.
--   * While any limit order is open the price feed runs about once a minute.
--   * At most 20 open orders per user.
--
-- Rounding is the market order rule, against the user, applied to the price
-- the order fills at:
--   buy cost      = ceil(qty x price x 100)
--   sell proceeds = floor(qty x price x 100)
--   fee           = ceil(cost or proceeds x fee_bps / 10000)
-- A buy limit holds ceil(qty x limit x 100) + its fee; fee_bps is fixed on the
-- order at placement, so the fill recomputes exactly the held amount.
--
-- Lock order everywhere: order rows (matching claims them SKIP LOCKED), then
-- wallets ascending, then holdings ascending. Placement and market orders take
-- the Spot wallet, then the holding, and never wait for an order row.
--
-- Also replaced here:
--   * holding_apply gains p_held_delta (dropped and recreated, as wallet_apply
--     was, so no ambiguous overload is left).
--   * spot_market_order: a replay matches market orders only, and a sell takes
--     cost basis over available_qty + held_qty (the basis covers both).
--   * ingest_prices: fills the limit orders its snapshots cross, after options
--     settlement, in the same transaction.
--   * price_tick: also fires about once a minute while a limit order is open.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Types
-- -----------------------------------------------------------------------------
create type public.order_type   as enum ('market', 'limit');
create type public.order_status as enum ('open', 'filled', 'canceled');

-- -----------------------------------------------------------------------------
-- 2. orders: limit and hold columns. Every existing row is a filled market
--    order. The fill columns are null until the order fills; CHECKs tie them to
--    the status.
-- -----------------------------------------------------------------------------
alter table public.orders
  add column type        public.order_type   not null default 'market',
  add column status      public.order_status not null default 'filled',
  add column limit_price numeric(38,18) check (limit_price > 0),
  add column hold_cents  bigint         check (hold_cents > 0),       -- buy limits that rested
  add column hold_qty    numeric(38,18) check (hold_qty > 0),         -- sell limits that rested
  add column filled_at   timestamptz,
  add column canceled_at timestamptz;

update public.orders set filled_at = created_at;

alter table public.orders
  alter column type           drop default,
  alter column status         drop default,
  alter column price          drop not null,
  alter column price_at       drop not null,
  alter column price_source   drop not null,
  alter column notional_cents drop not null,
  alter column fee_cents      drop not null,
  drop constraint orders_check,
  -- A market order is always filled and holds nothing; a limit order has a limit.
  add constraint orders_type_chk check (
    (type = 'market' and status = 'filled' and limit_price is null and hold_cents is null and hold_qty is null)
    or (type = 'limit' and limit_price is not null)),
  -- A buy holds cents, a sell holds quantity; only an order filled at placement holds nothing.
  add constraint orders_hold_chk check (
    (hold_cents is null or side = 'buy') and (hold_qty is null or side = 'sell')
    and (status = 'filled' or hold_cents is not null or hold_qty is not null)),
  add constraint orders_status_chk check (case status
    when 'filled' then price is not null and price_at is not null and price_source is not null
                   and notional_cents is not null and fee_cents is not null and filled_at is not null
                   and canceled_at is null and (side = 'sell') = (realized_pnl_cents is not null)
    else price is null and price_at is null and price_source is null and notional_cents is null
         and fee_cents is null and realized_pnl_cents is null and filled_at is null
         and (status = 'canceled') = (canceled_at is not null)
    end),
  -- A limit order never fills at a worse price than its limit.
  add constraint orders_limit_fill_chk check (
    type = 'market' or status <> 'filled'
    or (side = 'buy' and price <= limit_price) or (side = 'sell' and price >= limit_price));

create index orders_open_market_idx on public.orders (market_id) where status = 'open';
create index orders_open_user_idx   on public.orders (user_id)   where status = 'open';

-- -----------------------------------------------------------------------------
-- 3. spot_holdings.held_qty (sell limits) and the once-a-minute tick claim.
-- -----------------------------------------------------------------------------
alter table public.spot_holdings
  add column held_qty numeric(38,18) not null default 0 check (held_qty >= 0);

alter table public.system_state
  add column limit_tick_at timestamptz not null default '-infinity';

-- -----------------------------------------------------------------------------
-- 4. holding_apply gains p_held_delta. Caller holds the Spot wallet lock, then
--    the holding lock.
-- -----------------------------------------------------------------------------
drop function private.holding_apply(uuid, text, numeric, bigint);

create function private.holding_apply(
  p_user_id     uuid,
  p_asset       text,
  p_qty_delta   numeric,
  p_cost_delta  bigint,
  p_held_delta  numeric default 0
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
  if v_h.held_qty + p_held_delta < 0 then
    raise exception 'INVARIANT_HELD_NEGATIVE' using detail = format('%s %s', p_user_id, p_asset);
  end if;
  if v_h.cost_basis_cents + p_cost_delta < 0 then
    raise exception 'INVARIANT_HOLDING_NEGATIVE';
  end if;
  perform set_config('aureonx.balance_write', 'on', true);
  update public.spot_holdings
     set available_qty    = available_qty + p_qty_delta,
         held_qty         = held_qty + p_held_delta,
         cost_basis_cents = cost_basis_cents + p_cost_delta,
         updated_at       = now()
   where user_id = p_user_id and asset = p_asset
  returning * into v_h;
  perform set_config('aureonx.balance_write', 'off', true);
  return v_h;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. spot_apply_fill: the Bills rows and holding change for a filled order row
--    (market, limit at placement or a resting limit). p_from_hold takes the
--    buy cost and fee from held_cents, or the sell quantity from held_qty.
--    p_removed is the cost basis a sell takes out. Caller holds the wallet lock,
--    then the holding lock.
-- -----------------------------------------------------------------------------
create function private.spot_apply_fill(
  p_o               public.orders,
  p_base            text,
  p_price_decimals  integer,
  p_removed         bigint,
  p_from_hold       boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_qty   text := private.format_amount(p_o.qty, scale(trim_scale(p_o.qty)));
  v_price text := private.format_amount(p_o.price, p_price_decimals);
  v_held  boolean := p_from_hold and p_o.side = 'buy';   -- cash comes out of held_cents
begin
  if p_o.side = 'buy' then
    perform private.wallet_apply(p_o.wallet_id,
      case when v_held then 0 else -p_o.notional_cents end,
      case when v_held then -p_o.notional_cents else 0 end,
      'spot_buy', 'order', p_o.id, p_asset => p_base, p_asset_delta => p_o.qty,
      p_memo => format('Bought %s %s at %s', v_qty, p_base, v_price));
    -- The buy fee is part of the cost basis; it is realized when the asset is sold.
    perform private.holding_apply(p_o.user_id, p_base, p_o.qty, p_o.notional_cents + p_o.fee_cents);
  else
    perform private.holding_apply(p_o.user_id, p_base,
      case when p_from_hold then 0 else -p_o.qty end, -p_removed,
      case when p_from_hold then -p_o.qty else 0 end);
    perform private.wallet_apply(p_o.wallet_id, p_o.notional_cents, 0, 'spot_sell', 'order', p_o.id,
      p_pnl_cents => p_o.notional_cents - p_removed, p_asset => p_base, p_asset_delta => -p_o.qty,
      p_memo => format('Sold %s %s at %s', v_qty, p_base, v_price));
  end if;
  if p_o.fee_cents > 0 then
    perform private.wallet_apply(p_o.wallet_id,
      case when v_held then 0 else -p_o.fee_cents end,
      case when v_held then -p_o.fee_cents else 0 end,
      'fee', 'order', p_o.id,
      p_pnl_cents => case when p_o.side = 'sell' then -p_o.fee_cents else 0 end,
      p_memo => 'Trading fee');
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. spot_market_order: unchanged rules, except that a replay matches market
--    orders only and a sell takes basis over available + held quantity.
-- -----------------------------------------------------------------------------
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
  perform private.assert_active(v_uid);
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
    if v_o.type <> 'market' or v_o.market_id <> p_market_id or v_o.side <> p_side or v_o.qty <> v_qty then
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
    v_removed := floor(v_h.cost_basis_cents * v_qty / (v_h.available_qty + v_h.held_qty));
    v_pnl     := v_notional - v_fee - v_removed;
  end if;

  insert into public.orders (user_id, wallet_id, market_id, type, status, side, qty, price, price_at,
                             price_source, notional_cents, fee_bps, fee_cents, realized_pnl_cents,
                             client_request_id, filled_at)
  values (v_uid, v_wallet.id, p_market_id, 'market', 'filled', p_side, v_qty, v_price, v_s.fetched_at,
          v_s.source, v_notional, v_cfg.fee_bps, v_fee, v_pnl, p_client_request_id, now())
  returning * into v_o;

  perform private.spot_apply_fill(v_o, v_m.base, v_m.price_decimals, v_removed, false);
  return v_o;
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. spot_limit_order: no price input but the limit. Idempotent on the key (the
--    same key with the same parameters returns the first order, whatever its
--    status now; anything else is IDEMPOTENCY_CONFLICT). Locks: Spot wallet,
--    then the holding. Marketable against a fresh snapshot: fills now at the ask
--    or bid. Otherwise it rests with its hold; a missing or stale snapshot never
--    refuses a limit order, it rests.
-- -----------------------------------------------------------------------------
create function public.spot_limit_order(
  p_market_id         text,
  p_side              public.order_side,
  p_qty               text,
  p_limit_price       text,
  p_client_request_id uuid
)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_max_open  constant integer := 20;  -- open orders per user (owner decision)
  v_uid       uuid := auth.uid();
  v_m         public.markets;
  v_cfg       public.spot_config;
  v_wallet    public.wallets;
  v_h         public.spot_holdings;
  v_s         public.price_snapshots;
  v_qty       numeric;
  v_limit     numeric;
  v_price     numeric;
  v_value     numeric;     -- qty x limit x 100, unrounded
  v_notional  bigint;
  v_fee       bigint;
  v_removed   bigint := 0;
  v_pnl       bigint;
  v_open      integer;
  v_o         public.orders;
begin
  if v_uid is null then raise exception 'UNAUTHENTICATED'; end if;
  perform private.assert_active(v_uid);
  if p_market_id is null or p_side is null or p_client_request_id is null then
    raise exception 'INVALID_ARGUMENT';
  end if;

  select * into v_m from public.markets where id = p_market_id;
  if not found then raise exception 'MARKET_NOT_FOUND'; end if;

  v_qty   := private.parse_decimal(p_qty);
  v_limit := private.parse_decimal(p_limit_price);

  select * into v_wallet from public.wallets where user_id = v_uid and account = 'spot';
  if not found then raise exception 'WALLET_NOT_FOUND'; end if;
  perform private.lock_wallets(array[v_wallet.id]);
  v_h := private.lock_holding(v_uid, v_m.base);

  select * into v_o from public.orders
   where user_id = v_uid and client_request_id = p_client_request_id;
  if found then
    if v_o.type <> 'limit' or v_o.market_id <> p_market_id or v_o.side <> p_side
       or v_o.qty <> v_qty or v_o.limit_price <> v_limit then
      raise exception 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_o;
  end if;

  if not v_m.enabled then raise exception 'MARKET_DISABLED'; end if;
  if v_qty <= 0 then raise exception 'INVALID_QTY'; end if;
  if v_qty <> trunc(v_qty, v_m.qty_decimals) then
    raise exception 'INVALID_QTY' using detail = format('max_decimals=%s', v_m.qty_decimals);
  end if;
  if v_limit <= 0 then raise exception 'INVALID_PRICE'; end if;
  if v_limit <> trunc(v_limit, v_m.price_decimals) then
    raise exception 'INVALID_PRICE' using detail = format('max_decimals=%s', v_m.price_decimals);
  end if;

  v_value := v_qty * v_limit * 100;
  if v_value < v_m.min_notional_cents then
    raise exception 'BELOW_MIN_NOTIONAL' using detail = format('min_cents=%s', v_m.min_notional_cents);
  end if;
  if v_value > 100000000000000 then raise exception 'INVALID_QTY' using detail = 'too_large'; end if;

  select * into v_wallet from public.wallets where id = v_wallet.id;
  select * into v_cfg from public.spot_config where id;
  select * into v_s from public.price_snapshots s
   where s.market_id = p_market_id
     and s.fetched_at > now() - make_interval(secs => v_cfg.max_price_age_s)
     and s.fetched_at <= now();

  -- Marketable now: fill at the snapshot price, which is at or better than the limit.
  if found and (case p_side when 'buy' then v_s.ask <= v_limit else v_s.bid >= v_limit end) then
    v_price    := case when p_side = 'buy' then v_s.ask else v_s.bid end;
    v_notional := case when p_side = 'buy' then ceil(v_qty * v_price * 100) else floor(v_qty * v_price * 100) end;
    if v_notional > 100000000000000 then raise exception 'INVALID_QTY' using detail = 'too_large'; end if;
    v_fee      := ceil(v_notional * v_cfg.fee_bps / 10000.0);
    if p_side = 'buy' and v_wallet.available_cents < v_notional + v_fee then
      raise exception 'INSUFFICIENT_FUNDS'
        using detail = format('available=%s required=%s', v_wallet.available_cents, v_notional + v_fee);
    end if;
    if p_side = 'sell' then
      if v_h.available_qty < v_qty then
        raise exception 'INSUFFICIENT_ASSET'
          using detail = format('available=%s required=%s', v_h.available_qty, v_qty);
      end if;
      v_removed := floor(v_h.cost_basis_cents * v_qty / (v_h.available_qty + v_h.held_qty));
      v_pnl     := v_notional - v_fee - v_removed;
    end if;

    insert into public.orders (user_id, wallet_id, market_id, type, status, side, qty, limit_price,
                               price, price_at, price_source, notional_cents, fee_bps, fee_cents,
                               realized_pnl_cents, client_request_id, filled_at)
    values (v_uid, v_wallet.id, p_market_id, 'limit', 'filled', p_side, v_qty, v_limit,
            v_price, v_s.fetched_at, v_s.source, v_notional, v_cfg.fee_bps, v_fee,
            v_pnl, p_client_request_id, now())
    returning * into v_o;

    perform private.spot_apply_fill(v_o, v_m.base, v_m.price_decimals, v_removed, false);
    return v_o;
  end if;

  -- Rests: cap, then hold. The Spot wallet lock serializes this user's placements,
  -- so the count is exact.
  select count(*) into v_open from public.orders where user_id = v_uid and status = 'open';
  if v_open >= c_max_open then
    raise exception 'OPEN_ORDERS_LIMIT' using detail = format('max=%s', c_max_open);
  end if;

  if p_side = 'buy' then
    v_notional := ceil(v_value);
    v_fee      := ceil(v_notional * v_cfg.fee_bps / 10000.0);
    if v_wallet.available_cents < v_notional + v_fee then
      raise exception 'INSUFFICIENT_FUNDS'
        using detail = format('available=%s required=%s', v_wallet.available_cents, v_notional + v_fee);
    end if;
  elsif v_h.available_qty < v_qty then
    raise exception 'INSUFFICIENT_ASSET'
      using detail = format('available=%s required=%s', v_h.available_qty, v_qty);
  end if;

  insert into public.orders (user_id, wallet_id, market_id, type, status, side, qty, limit_price,
                             hold_cents, hold_qty, fee_bps, client_request_id)
  values (v_uid, v_wallet.id, p_market_id, 'limit', 'open', p_side, v_qty, v_limit,
          case when p_side = 'buy' then v_notional + v_fee end,
          case when p_side = 'sell' then v_qty end,
          v_cfg.fee_bps, p_client_request_id)
  returning * into v_o;

  if p_side = 'buy' then
    perform private.wallet_apply(v_wallet.id, -v_o.hold_cents, v_o.hold_cents, 'order_hold', 'order', v_o.id,
      p_memo => format('Buy limit %s %s at %s', private.format_amount(v_qty, scale(trim_scale(v_qty))),
                       v_m.base, private.format_amount(v_limit, v_m.price_decimals)));
  else
    -- A sell hold moves no cash, so it writes no Bills row.
    perform private.holding_apply(v_uid, v_m.base, -v_qty, 0, v_qty);
  end if;
  return v_o;
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. spot_cancel_order: own orders only. Guarded open -> canceled, then the
--    hold goes back. A second cancel returns the canceled row; a filled order is
--    ORDER_NOT_OPEN. Locks: the order row, the Spot wallet, the holding. A
--    suspended account can still cancel (it removes exposure).
-- -----------------------------------------------------------------------------
create function public.spot_cancel_order(p_order_id uuid)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_o    public.orders;
  v_m    public.markets;
begin
  if v_uid is null then raise exception 'UNAUTHENTICATED'; end if;
  if p_order_id is null then raise exception 'INVALID_ARGUMENT'; end if;

  select * into v_o from public.orders where id = p_order_id and user_id = v_uid for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if v_o.status = 'canceled' then return v_o; end if;
  if v_o.status <> 'open' then raise exception 'ORDER_NOT_OPEN'; end if;

  select * into v_m from public.markets where id = v_o.market_id;
  perform private.lock_wallets(array[v_o.wallet_id]);
  perform private.lock_holding(v_uid, v_m.base);

  update public.orders set status = 'canceled', canceled_at = now()
   where id = p_order_id and status = 'open'
  returning * into v_o;

  if v_o.side = 'buy' then
    perform private.wallet_apply(v_o.wallet_id, v_o.hold_cents, -v_o.hold_cents, 'order_release', 'order', v_o.id,
      p_memo => format('Buy limit %s %s at %s', private.format_amount(v_o.qty, scale(trim_scale(v_o.qty))),
                       v_m.base, private.format_amount(v_o.limit_price, v_m.price_decimals)));
  else
    perform private.holding_apply(v_uid, v_m.base, v_o.hold_qty, 0, -v_o.hold_qty);
  end if;
  return v_o;
end;
$$;

-- -----------------------------------------------------------------------------
-- 9. Matching.
-- 9.1 claim_spot_fills: claims (FOR UPDATE SKIP LOCKED) the open limit orders
--     that the stored snapshots fill now, then locks their Spot wallets together
--     with p_extra_wallets ascending, then their holdings ascending. A fill
--     needs a fresh snapshot taken at or after the order (fetched_at >=
--     created_at, no look-back) with ask <= limit (buy) or bid >= limit (sell).
--     p_market_ids null means every market.
-- -----------------------------------------------------------------------------
create function private.claim_spot_fills(p_market_ids text[], p_extra_wallets uuid[] default '{}')
returns uuid[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  v_ids := array(
    select o.id
      from public.orders o
      join public.price_snapshots s on s.market_id = o.market_id
     where o.status = 'open'
       and (p_market_ids is null or o.market_id = any (p_market_ids))
       and s.fetched_at >= o.created_at
       and s.fetched_at > now() - make_interval(secs => (select c.max_price_age_s from public.spot_config c where c.id))
       and s.fetched_at <= now()
       and case o.side when 'buy' then s.ask <= o.limit_price else s.bid >= o.limit_price end
     order by o.id
       for update of o skip locked);

  perform private.lock_wallets(coalesce(p_extra_wallets, '{}')
                               || array(select o.wallet_id from public.orders o where o.id = any (v_ids)));
  perform 1
     from public.spot_holdings h
     join public.orders o on o.user_id = h.user_id
     join public.markets m on m.id = o.market_id and m.base = h.asset
    where o.id = any (v_ids)
    order by h.user_id, h.asset
      for update of h;
  return v_ids;
end;
$$;

-- 9.2 fill_spot_orders: fills claimed orders at their limit price, each in its own
--     subtransaction (a failure leaves that order open for the next snapshot or
--     the safety net). Re-checks the snapshot, then the guarded open -> filled
--     transition decides who pays. Never checks suspension: fills always happen.
create function private.fill_spot_orders(p_ids uuid[], out filled integer, out errors integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id        uuid;
  v_o         public.orders;
  v_m         public.markets;
  v_s         public.price_snapshots;
  v_h         public.spot_holdings;
  v_max_age   integer;
  v_notional  bigint;
  v_fee       bigint;
  v_removed   bigint;
begin
  filled := 0; errors := 0;
  select max_price_age_s into v_max_age from public.spot_config where id;
  foreach v_id in array coalesce(p_ids, '{}') loop
    begin
      select * into v_o from public.orders where id = v_id and status = 'open' for update;
      if not found then continue; end if;
      select * into v_s from public.price_snapshots s
       where s.market_id = v_o.market_id
         and s.fetched_at >= v_o.created_at
         and s.fetched_at > now() - make_interval(secs => v_max_age)
         and s.fetched_at <= now()
         and case v_o.side when 'buy' then s.ask <= v_o.limit_price else s.bid >= v_o.limit_price end;
      if not found then continue; end if;

      select * into v_m from public.markets where id = v_o.market_id;
      v_notional := case when v_o.side = 'buy' then ceil(v_o.qty * v_o.limit_price * 100)
                         else floor(v_o.qty * v_o.limit_price * 100) end;
      v_fee      := ceil(v_notional * v_o.fee_bps / 10000.0);
      if v_o.side = 'buy' and v_notional + v_fee <> v_o.hold_cents then
        raise exception 'INVARIANT_HOLD_MISMATCH' using detail = v_o.id::text;
      end if;

      perform private.lock_wallets(array[v_o.wallet_id]);
      v_h := private.lock_holding(v_o.user_id, v_m.base);
      v_removed := case when v_o.side = 'sell'
                        then floor(v_h.cost_basis_cents * v_o.qty / (v_h.available_qty + v_h.held_qty))
                        else 0 end;

      update public.orders
         set status = 'filled', price = v_o.limit_price, price_at = v_s.fetched_at, price_source = v_s.source,
             notional_cents = v_notional, fee_cents = v_fee, filled_at = now(),
             realized_pnl_cents = case when v_o.side = 'sell' then v_notional - v_fee - v_removed end
       where id = v_id and status = 'open'
      returning * into v_o;
      if not found then continue; end if;

      perform private.spot_apply_fill(v_o, v_m.base, v_m.price_decimals, v_removed, true);
      filled := filled + 1;
    exception when others then
      errors := errors + 1;
      raise warning 'aureonx fill_spot_orders failed for %: %', v_id, sqlerrm;
    end;
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- 10. ingest_prices: unchanged until the lock step. The lock step now claims the
--     limit orders the written snapshots fill and locks their Spot wallets
--     together with the options wallets in one ascending pass (one pass, so an
--     ingest never holds a high wallet while waiting for a low one); options
--     settle as before, then the claimed orders fill. Returns filled and
--     fill_errors too.
-- -----------------------------------------------------------------------------
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
  v_fill   integer := 0;   -- limit orders filled
  v_ferr   integer := 0;   -- limit orders whose fill failed (left open)
  v_batch  integer;
  v_all    text[] := '{}';         -- every written snapshot
  v_mk     text[] := '{}';         -- written snapshots of options markets, in order
  v_mid    numeric[] := '{}';
  v_at     timestamptz[] := '{}';
  v_orders uuid[];
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
        v_all := v_all || v_m.id;
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

  -- Claim the limit orders these snapshots fill, then lock their Spot wallets
  -- and the options wallets of every position these snapshots settle in one
  -- ascending pass, then their holdings. The options window is settle_options'
  -- own, per written snapshot.
  v_orders := private.claim_spot_fills(v_all, array(
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

  select f.filled, f.errors into v_fill, v_ferr from private.fill_spot_orders(v_orders) f;

  return jsonb_build_object('accepted', v_ok, 'rejected', v_rej, 'ignored', v_ign,
                            'settled', v_set, 'settle_errors', v_err,
                            'filled', v_fill, 'fill_errors', v_ferr);
end;
$$;

-- -----------------------------------------------------------------------------
-- 11. price_tick: with no demand window and no open options position, an open
--     limit order alone fires the feed about once a minute (a conditional
--     UPDATE claims each minute, so the 10 s schedule posts at most once in 55 s).
-- -----------------------------------------------------------------------------
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
    update public.system_state set limit_tick_at = now()
     where id and limit_tick_at <= now() - interval '55 seconds'
       and exists (select 1 from public.orders where status = 'open');
    if not found then return; end if;
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
-- 12. Grants. New functions are not executable by default.
-- -----------------------------------------------------------------------------
revoke all on function private.holding_apply(uuid, text, numeric, bigint, numeric)              from public, anon, authenticated;
revoke all on function private.spot_apply_fill(public.orders, text, integer, bigint, boolean)  from public, anon, authenticated;
revoke all on function private.claim_spot_fills(text[], uuid[])                                from public, anon, authenticated;
revoke all on function private.fill_spot_orders(uuid[])                                        from public, anon, authenticated;
revoke all on function public.spot_limit_order(text, public.order_side, text, text, uuid)      from public, anon;
revoke all on function public.spot_cancel_order(uuid)                                          from public, anon;

grant execute on function public.spot_limit_order(text, public.order_side, text, text, uuid) to authenticated;
grant execute on function public.spot_cancel_order(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 13. Safety net: fills any order a snapshot crossed but ingest_prices did not
--     fill (skipped while locked, or a failed fill). One indexed read when no
--     order is open.
-- -----------------------------------------------------------------------------
select cron.schedule('aureonx-spot-match', '* * * * *',
  $c$ select private.fill_spot_orders(private.claim_spot_fills(null)); $c$);
