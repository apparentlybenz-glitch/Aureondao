-- =============================================================================
-- Slice 7: account suspension, admin Audit Log read, foreign key indexes.
-- Applied through the Management API.
--
-- Owner decisions (slice 7):
--   * An admin can suspend an account. A suspended user cannot open Spot orders,
--     open Options positions or transfer between wallets (ACCOUNT_SUSPENDED).
--   * Settlement, the void job and admin_adjust_balance never check it:
--     settlement always pays out, and an admin can still credit a suspended
--     account.
--   * The Audit Log section reads admin_audit_log, so the admin-only read policy
--     below replaces the slice 2 "not readable over the API" rule for admins.
-- =============================================================================

-- 1. Suspension state. Both null when active; a reason of 3 to 200 characters
-- whenever suspended. Users read both under the existing profiles_select policy
-- (the table grant is SELECT only, so there is no client write).
alter table public.profiles
  add column suspended_at      timestamptz,
  add column suspension_reason text,
  add constraint profiles_suspension_chk check (
    (suspended_at is null and suspension_reason is null)
    or (suspended_at is not null and char_length(suspension_reason) between 3 and 200)
  );

-- 2. private.assert_active: raises ACCOUNT_SUSPENDED. FOR SHARE makes it exact
-- against a concurrent suspension: a suspension that commits first is seen, and
-- one that arrives later waits for the money call to finish.
create or replace function private.assert_active(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_suspended timestamptz;
begin
  select suspended_at into v_suspended from public.profiles where id = p_user_id for share;
  if v_suspended is not null then
    raise exception 'ACCOUNT_SUSPENDED';
  end if;
end;
$$;

-- 3. admin_set_suspension: the same checks as admin_adjust_balance (claim, aal2,
-- live admin row). A reason of 3 to 200 characters is required to suspend; to
-- unsuspend it is optional. Suspending an already suspended user keeps the
-- original suspended_at and replaces the reason. Idempotent on the key (the
-- audit row is the record); always writes one audit row.
create or replace function public.admin_set_suspension(
  p_user_id           uuid,
  p_suspended         boolean,
  p_reason            text,
  p_client_request_id uuid
)
returns public.admin_audit_log
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin  uuid := auth.uid();
  v_reason text := nullif(trim(p_reason), '');
  v_action text := case when p_suspended then 'suspend' else 'unsuspend' end;
  v_a      public.admin_audit_log;
begin
  if v_admin is null then raise exception 'UNAUTHENTICATED'; end if;
  if coalesce(auth.jwt() ->> 'user_role', '') <> 'admin' then raise exception 'FORBIDDEN'; end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then raise exception 'AAL2_REQUIRED'; end if;
  if not private.is_admin() then raise exception 'FORBIDDEN'; end if;

  if p_user_id is null or p_suspended is null or p_client_request_id is null then
    raise exception 'INVALID_ARGUMENT';
  end if;
  if p_suspended and coalesce(char_length(v_reason), 0) < 3 then raise exception 'NOTE_REQUIRED'; end if;
  if char_length(v_reason) > 200 then raise exception 'NOTE_REQUIRED'; end if;

  -- The profile lock serializes calls on one user, so a concurrent call with the
  -- same key sees the audit row below once it commits.
  perform 1 from public.profiles where id = p_user_id for update;
  if not found then raise exception 'INVALID_ARGUMENT'; end if;

  select * into v_a from public.admin_audit_log where client_request_id = p_client_request_id;
  if found then
    if v_a.action <> v_action or v_a.target_user_id is distinct from p_user_id
       or (v_a.payload ->> 'reason') is distinct from v_reason then
      raise exception 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_a;
  end if;

  if p_suspended then
    update public.profiles
       set suspended_at = coalesce(suspended_at, now()), suspension_reason = v_reason
     where id = p_user_id;
  else
    update public.profiles set suspended_at = null, suspension_reason = null where id = p_user_id;
  end if;

  insert into public.admin_audit_log (admin_id, action, target_user_id, payload, client_request_id)
  values (v_admin, v_action, p_user_id, jsonb_build_object('reason', v_reason), p_client_request_id)
  returning * into v_a;
  return v_a;
end;
$$;

-- 4. The three money RPCs call assert_active first. Bodies as in
-- 20261025233700 (transfer) and 20261027140000 (open_option, spot_market_order)
-- plus that one call; signatures and grants are unchanged.

create or replace function public.transfer_between_wallets(
  p_from              public.wallet_account,
  p_to                public.wallet_account,
  p_amount_cents      bigint,
  p_client_request_id uuid
)
returns public.transfers
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_from uuid;
  v_to   uuid;
  v_t    public.transfers;
begin
  if v_uid is null then raise exception 'UNAUTHENTICATED'; end if;
  perform private.assert_active(v_uid);
  if p_client_request_id is null or p_from is null or p_to is null then
    raise exception 'INVALID_ARGUMENT';
  end if;
  if p_from = p_to then raise exception 'SAME_WALLET'; end if;
  if p_amount_cents is null or p_amount_cents <= 0 then raise exception 'INVALID_AMOUNT'; end if;

  select id into v_from from public.wallets where user_id = v_uid and account = p_from;
  select id into v_to   from public.wallets where user_id = v_uid and account = p_to;
  if v_from is null or v_to is null then raise exception 'WALLET_NOT_FOUND'; end if;

  perform private.lock_wallets(array[v_from, v_to]);

  select * into v_t from public.transfers
   where user_id = v_uid and client_request_id = p_client_request_id;
  if found then
    if v_t.from_wallet_id <> v_from or v_t.to_wallet_id <> v_to or v_t.amount_cents <> p_amount_cents then
      raise exception 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_t;
  end if;

  insert into public.transfers (user_id, from_wallet_id, to_wallet_id, from_account, to_account,
                                amount_cents, client_request_id)
  values (v_uid, v_from, v_to, p_from, p_to, p_amount_cents, p_client_request_id)
  returning * into v_t;

  perform private.wallet_apply(v_from, -p_amount_cents, 0, 'transfer_out', 'transfer', v_t.id,
                               p_counter_account => p_to);
  perform private.wallet_apply(v_to, p_amount_cents, 0, 'transfer_in', 'transfer', v_t.id,
                               p_counter_account => p_from);
  return v_t;
end;
$$;

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
  perform private.assert_active(v_uid);
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

-- 5. Audit Log read for admins only (aal2 through private.is_admin()).
create policy admin_audit_log_select on public.admin_audit_log for select to authenticated
  using ((select private.is_admin()));
grant select on public.admin_audit_log to authenticated;

-- 6. Grants. New functions are not executable by default.
revoke all on function private.assert_active(uuid) from public, anon, authenticated;
revoke all on function public.admin_set_suspension(uuid, boolean, text, uuid) from public, anon;
grant execute on function public.admin_set_suspension(uuid, boolean, text, uuid) to authenticated;

-- 7. Single-column indexes for the two foreign keys the advisor still lists.
create index if not exists orders_market_id_idx on public.orders (market_id);
create index if not exists transfers_to_wallet_id_idx on public.transfers (to_wallet_id);
