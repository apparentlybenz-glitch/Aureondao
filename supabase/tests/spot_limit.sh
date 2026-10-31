#!/bin/bash
# Spot limit orders (20261031180000_spot_limit_orders.sql): spot_limit_order, spot_cancel_order,
# matching in ingest_prices, the fill_spot_orders safety net and the price_tick claim.
# Prints PASS/FAIL lines (no keys) and exits non-zero if any check fails.
# Usage: supabase/tests/spot_limit.sh [t1 ... t7]  (Management API, write token required)
# Each step is ONE request: it creates its test users and two test markets (ZZT-USDT enabled,
# ZZD-USDT disabled, both without Options), runs its checks and ends by raising an exception that
# carries the results, so the whole step rolls back and nothing is ever committed. No real market,
# snapshot or position is touched, and live cron jobs never see the test rows.
# The project comes from SUPABASE_PROJECT_REF; abort before any query unless it matches the
# ref in NEXT_PUBLIC_SUPABASE_URL.
REF=${SUPABASE_PROJECT_REF:?SUPABASE_PROJECT_REF is not set}
URL_REF=$(printf '%s' "${NEXT_PUBLIC_SUPABASE_URL:-}" | sed -nE 's#^https://([a-z0-9]+)\.supabase\.co/?$#\1#p')
if [ "$REF" != "$URL_REF" ]; then echo "SUPABASE_PROJECT_REF does not match NEXT_PUBLIC_SUPABASE_URL; aborting." >&2; exit 1; fi
FAILS=0
run() { jq -Rs '{query: ., read_only: false}' | curl -sS -X POST "https://api.supabase.com/v1/projects/$REF/database/query" -H 'Content-Type: application/json' --data-binary @-; echo; }

# Helpers created at the start of every step (temporary, dropped with the rollback).
read -r -d '' PRELUDE <<'SQL'
create temp table sl_t (n serial, label text, ok boolean, got text);
create function pg_temp.chk(p_label text, p_ok boolean, p_got text default null) returns void language sql as
  $f$ insert into sl_t (label, ok, got) values (p_label, coalesce(p_ok, false), p_got) $f$;
-- Test users, Spot wallet: A 10,000.00, B 100.00, C 1,000.00 (C is suspended in t6).
create function pg_temp.u(p text) returns uuid language sql immutable as $f$
  select case p when 'A' then 'aaaaaaaa-0000-4000-8000-0000000000b1'::uuid when 'B' then 'bbbbbbbb-0000-4000-8000-0000000000b2'::uuid
                when 'C' then 'cccccccc-0000-4000-8000-0000000000b3'::uuid end $f$;
create function pg_temp.k(n integer) returns uuid language sql immutable as
  $f$ select ('b0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $f$;
-- Run SQL as a role and return the first column of the first row as text, or 'ERR <message> detail=<detail>'.
create function pg_temp.as_role(p_role text, p_uid uuid, p_user_role text, p_sql text) returns text language plpgsql as $f$
declare v text; v_d text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', p_role, 'aal', 'aal1', 'user_role', p_user_role)::text, true);
  execute format('set local role %I', p_role);
  begin
    execute p_sql into v;
    v := coalesce(v, 'ok');
  exception when others then
    get stacked diagnostics v_d = pg_exception_detail;
    v := 'ERR ' || sqlerrm || coalesce(' detail=' || nullif(v_d, ''), '');
  end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  return v;
end $f$;
create function pg_temp.as_user(p_uid uuid, p_sql text) returns text language sql as
  $f$ select pg_temp.as_role('authenticated', p_uid, 'user', p_sql) $f$;
-- Place a limit or market order and return its status or the error.
create function pg_temp.lim(p_who text, p_side text, p_qty text, p_price text, p_key integer, p_market text default 'ZZT-USDT')
  returns text language sql as
  $f$ select pg_temp.as_user(pg_temp.u(p_who), format('select (public.spot_limit_order(%L, %L, %L, %L, %L)).status::text',
        p_market, p_side, p_qty, p_price, pg_temp.k(p_key))) $f$;
create function pg_temp.mkt(p_who text, p_side text, p_qty text, p_key integer) returns text language sql as
  $f$ select pg_temp.as_user(pg_temp.u(p_who), format('select (public.spot_market_order(%L, %L, %L, %L)).status::text',
        'ZZT-USDT', p_side, p_qty, pg_temp.k(p_key))) $f$;
create function pg_temp.ord(p_who text, p_key integer) returns public.orders language sql as
  $f$ select * from public.orders where user_id = pg_temp.u(p_who) and client_request_id = pg_temp.k(p_key) $f$;
-- p_who cancels p_owner's order p_key.
create function pg_temp.cancel(p_who text, p_owner text, p_key integer) returns text language sql as
  $f$ select pg_temp.as_user(pg_temp.u(p_who), format('select (public.spot_cancel_order(%L)).status::text',
        (pg_temp.ord(p_owner, p_key)).id)) $f$;
-- The helpers above are volatile, so a check sees writes made earlier in the same statement.
-- Write the ZZT-USDT snapshot directly (no forward-only rule), as if an ingest had written it.
create function pg_temp.snap(p_bid text, p_ask text, p_at timestamptz) returns void language sql as $f$
  insert into public.price_snapshots (market_id, bid, ask, fetched_at, source)
  values ('ZZT-USDT', p_bid::numeric, p_ask::numeric, p_at, 'vision')
  on conflict (market_id) do update set bid = excluded.bid, ask = excluded.ask, fetched_at = excluded.fetched_at $f$;
-- One ZZT-USDT quote through ingest_prices as service_role; returns its result.
create function pg_temp.ingest(p_bid text, p_ask text, p_at timestamptz) returns jsonb language sql as $f$
  select pg_temp.as_role('service_role', null, null, format('select public.ingest_prices(%L::jsonb)::text',
    jsonb_build_array(jsonb_build_object('market_id', 'ZZT-USDT', 'bid', p_bid, 'ask', p_ask, 'source', 'vision', 'ts', p_at))))::jsonb $f$;
create function pg_temp.match() returns integer language sql as
  $f$ select (private.fill_spot_orders(private.claim_spot_fills(array['ZZT-USDT']))).filled $f$;
create function pg_temp.wal(p text) returns text language sql as
  $f$ select available_cents || '/' || held_cents from public.wallets where user_id = pg_temp.u(p) and account = 'spot' $f$;
create function pg_temp.hold(p text) returns text language sql as $f$
  select trim_scale(available_qty) || '/' || trim_scale(held_qty) || '/' || cost_basis_cents
    from public.spot_holdings where user_id = pg_temp.u(p) and asset = 'ZZT' $f$;
create function pg_temp.bills(p_who text, p_key integer) returns text language sql as $f$
  select string_agg(l.kind || ' ' || l.delta_cents || ' held ' || l.held_delta_cents
                    || coalesce(' asset ' || trim_scale(l.asset_delta), '') || ' pnl ' || l.pnl_cents, ', ' order by l.id)
    from public.ledger l where l.ref_type = 'order' and l.ref_id = (pg_temp.ord(p_who, p_key)).id $f$;
-- Sum of ledger = balances, and the holds equal what the open orders reserve.
create function pg_temp.reconcile() returns void language sql as $f$
  select pg_temp.chk('Spot wallets equal the ledger sums (available and held)',
         bool_and(w.available_cents = (select coalesce(sum(l.delta_cents), 0) from public.ledger l where l.wallet_id = w.id)
              and w.held_cents = (select coalesce(sum(l.held_delta_cents), 0) from public.ledger l where l.wallet_id = w.id)), null)
    from public.wallets w where w.user_id in (pg_temp.u('A'), pg_temp.u('B'), pg_temp.u('C')) and w.account = 'spot';
  select pg_temp.chk('held cash equals the open buy holds',
         bool_and(w.held_cents = (select coalesce(sum(o.hold_cents), 0) from public.orders o
                                   where o.user_id = w.user_id and o.status = 'open' and o.side = 'buy')), null)
    from public.wallets w where w.user_id in (pg_temp.u('A'), pg_temp.u('B'), pg_temp.u('C')) and w.account = 'spot';
  select pg_temp.chk('holdings equal the ledger asset legs, held qty equals the open sell holds',
         coalesce(bool_and(h.available_qty + h.held_qty = (select coalesce(sum(l.asset_delta), 0) from public.ledger l
                                                             where l.user_id = h.user_id and l.asset = h.asset)
              and h.held_qty = (select coalesce(sum(o.hold_qty), 0) from public.orders o
                                 where o.user_id = h.user_id and o.status = 'open' and o.side = 'sell')), true), null)
    from public.spot_holdings h where h.user_id in (pg_temp.u('A'), pg_temp.u('B'), pg_temp.u('C'));
$f$;

-- The two RPCs are not granted to authenticated until the Limit screen ships. A GRANT is
-- transactional, so this one rolls back with the step and the live grants stay as they are.
grant execute on function public.spot_limit_order(text, public.order_side, text, text, uuid) to authenticated;
grant execute on function public.spot_cancel_order(uuid) to authenticated;
update public.spot_config set fee_bps = 10, max_price_age_s = 60;
insert into public.markets (id, base, quote, display_symbol, vision_symbol, kucoin_symbol, price_decimals, sort_order,
                            enabled, qty_decimals, min_notional_cents, options_enabled)
values ('ZZT-USDT', 'ZZT', 'USDT', 'ZZT/USDT', 'ZZTUSDT', 'ZZT-USDT', 2, 9999, true,  3, 500, false),
       ('ZZD-USDT', 'ZZD', 'USDT', 'ZZD/USDT', 'ZZDUSDT', 'ZZD-USDT', 2, 9999, false, 3, 500, false);
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', pg_temp.u(x), 'authenticated', 'authenticated', 'spot-limit-test-' || lower(x) || '@aureonx.invalid',
       '', now(), '{}', json_build_object('nickname', 'Test' || x)::jsonb, now(), now()
  from unnest(array['A','B','C']) x;
select private.wallet_apply((select id from public.wallets where user_id = pg_temp.u(x) and account = 'spot'),
         c, 0, 'admin_credit', 'admin_adjustment', gen_random_uuid(), p_memo => 'Balance adjustment')
  from (values ('A', 1000000::bigint), ('B', 10000), ('C', 100000)) v(x, c);
SQL

read -r -d '' FINALE <<'SQL'
do $f$ begin
  raise exception 'SPOTTEST %', (select coalesce(jsonb_agg(jsonb_build_object('l', label, 'ok', ok, 'got', got) order by n), '[]'::jsonb)::text from sl_t);
end $f$;
SQL

body() {
case "$1" in
t1) cat <<'SQL'
-- T1 placement: holds rounded against the user, idempotency, validation, funds and holdings.
select pg_temp.snap('100.00', '100.10', now());
select pg_temp.chk('buy 0.333 at 99.99 below the ask rests', v = 'open', v) from (select pg_temp.lim('A', 'buy', '0.333', '99.99', 1) v) s;
select pg_temp.chk('... holds ceil(3329.667) + fee ceil(3.33) = 3334', (pg_temp.ord('A', 1)).hold_cents = 3334
         and (pg_temp.ord('A', 1)).price is null and (pg_temp.ord('A', 1)).fee_bps = 10, (pg_temp.ord('A', 1)).hold_cents::text);
select pg_temp.chk('... Spot wallet 996666 available, 3334 held', pg_temp.wal('A') = '996666/3334', pg_temp.wal('A'));
select pg_temp.chk('... one order_hold row', pg_temp.bills('A', 1) = 'order_hold -3334 held 3334 pnl 0', pg_temp.bills('A', 1));
select pg_temp.chk('replay with the same key returns the order', v = 'open', v) from (select pg_temp.lim('A', 'buy', '0.333', '99.99', 1) v) s;
select pg_temp.chk('... and holds nothing more', pg_temp.wal('A') = '996666/3334'
         and (select count(*) from public.orders where client_request_id = pg_temp.k(1)) = 1, pg_temp.wal('A'));
select pg_temp.chk('same key, another limit -> IDEMPOTENCY_CONFLICT', v ~ 'IDEMPOTENCY_CONFLICT', v) from (select pg_temp.lim('A', 'buy', '0.333', '99.98', 1) v) s;
select pg_temp.chk('same key as a market order -> IDEMPOTENCY_CONFLICT', v ~ 'IDEMPOTENCY_CONFLICT', v) from (select pg_temp.mkt('A', 'buy', '0.333', 1) v) s;
select pg_temp.chk('market buy 0.05 fills', v = 'filled', v) from (select pg_temp.mkt('A', 'buy', '0.05', 2) v) s;
select pg_temp.chk('... is type market, filled_at set', (pg_temp.ord('A', 2)).type = 'market' and (pg_temp.ord('A', 2)).filled_at is not null, null);
select pg_temp.chk('a market order key reused as a limit -> IDEMPOTENCY_CONFLICT', v ~ 'IDEMPOTENCY_CONFLICT', v) from (select pg_temp.lim('A', 'buy', '0.05', '99.99', 2) v) s;
select pg_temp.chk('limit 99.999 -> INVALID_PRICE max_decimals=2', v ~ 'INVALID_PRICE detail=max_decimals=2', v) from (select pg_temp.lim('A', 'buy', '0.333', '99.999', 3) v) s;
select pg_temp.chk('limit 0 -> INVALID_PRICE', v ~ 'INVALID_PRICE', v) from (select pg_temp.lim('A', 'buy', '0.333', '0', 3) v) s;
select pg_temp.chk('qty 0.3333 -> INVALID_QTY max_decimals=3', v ~ 'INVALID_QTY detail=max_decimals=3', v) from (select pg_temp.lim('A', 'buy', '0.3333', '99.99', 3) v) s;
select pg_temp.chk('limit 1e2 -> INVALID_NUMBER', v ~ 'INVALID_NUMBER', v) from (select pg_temp.lim('A', 'buy', '0.333', '1e2', 3) v) s;
select pg_temp.chk('0.050 at 99.99 (499.95) -> BELOW_MIN_NOTIONAL', v ~ 'BELOW_MIN_NOTIONAL detail=min_cents=500', v) from (select pg_temp.lim('A', 'buy', '0.050', '99.99', 3) v) s;
select pg_temp.chk('disabled market -> MARKET_DISABLED', v ~ 'MARKET_DISABLED', v) from (select pg_temp.lim('A', 'buy', '0.333', '99.99', 3, 'ZZD-USDT') v) s;
select pg_temp.chk('unknown market -> MARKET_NOT_FOUND', v ~ 'MARKET_NOT_FOUND', v) from (select pg_temp.lim('A', 'buy', '0.333', '99.99', 3, 'NOPE-USDT') v) s;
select pg_temp.chk('B buy 1 at 99.99 needs 10009 of 10000 -> INSUFFICIENT_FUNDS', v ~ 'INSUFFICIENT_FUNDS detail=available=10000 required=10009', v)
  from (select pg_temp.lim('B', 'buy', '1', '99.99', 1) v) s;
select pg_temp.chk('B buy 1 at 99.89 needs 9999 of 10000 and rests', v = 'open' and pg_temp.wal('B') = '1/9999', v || ' ' || pg_temp.wal('B'))
  from (select pg_temp.lim('B', 'buy', '1', '99.89', 2) v) s;
select pg_temp.chk('A sell 1 with 0.05 held -> INSUFFICIENT_ASSET', v ~ 'INSUFFICIENT_ASSET', v) from (select pg_temp.lim('A', 'sell', '1', '200.00', 4) v) s;
select pg_temp.chk('anon cannot call spot_limit_order', v ~ 'permission denied', v)
  from (select pg_temp.as_role('anon', null, null, format('select public.spot_limit_order(%L, %L, %L, %L, %L)', 'ZZT-USDT', 'buy', '1', '1', pg_temp.k(9))::text) v) s;
select pg_temp.reconcile();
SQL
;;
t2) cat <<'SQL'
-- T2 marketable at placement: fills now at the snapshot price, never worse than the limit; a stale snapshot rests.
select pg_temp.snap('100.00', '100.10', now());
select pg_temp.chk('buy 0.5 limit 101.00 fills at once', v = 'filled', v) from (select pg_temp.lim('A', 'buy', '0.5', '101.00', 1) v) s;
select pg_temp.chk('... at the ask 100.10, cost 5005 + fee 6, no hold', (pg_temp.ord('A', 1)).price = 100.10
         and (pg_temp.ord('A', 1)).notional_cents = 5005 and (pg_temp.ord('A', 1)).fee_cents = 6
         and (pg_temp.ord('A', 1)).hold_cents is null and (pg_temp.ord('A', 1)).limit_price = 101, (pg_temp.ord('A', 1))::text);
select pg_temp.chk('... Bills spot_buy and fee from available', pg_temp.bills('A', 1) = 'spot_buy -5005 held 0 asset 0.5 pnl 0, fee -6 held 0 pnl 0', pg_temp.bills('A', 1));
select pg_temp.chk('... wallet 994989/0, holding 0.5 basis 5011', pg_temp.wal('A') = '994989/0' and pg_temp.hold('A') = '0.5/0/5011', pg_temp.wal('A') || ' ' || pg_temp.hold('A'));
select pg_temp.chk('buy 0.333 limit = ask fills, cost ceil(3333.33) = 3334', v = 'filled' and (pg_temp.ord('A', 2)).notional_cents = 3334
         and (pg_temp.ord('A', 2)).fee_cents = 4, v || ' ' || (pg_temp.ord('A', 2)).notional_cents) from (select pg_temp.lim('A', 'buy', '0.333', '100.10', 2) v) s;
select pg_temp.snap('99.97', '100.10', now());
select pg_temp.chk('sell 0.333 limit 99.50 fills at once at the bid 99.97', v = 'filled' and (pg_temp.ord('A', 3)).price = 99.97, v)
  from (select pg_temp.lim('A', 'sell', '0.333', '99.50', 3) v) s;
select pg_temp.chk('... proceeds floor(3329.001) = 3329, fee 4, basis out floor(8349 x 0.333 / 0.833) = 3337, pnl -12',
         (pg_temp.ord('A', 3)).notional_cents = 3329 and (pg_temp.ord('A', 3)).fee_cents = 4 and (pg_temp.ord('A', 3)).realized_pnl_cents = -12,
         (pg_temp.ord('A', 3))::text);
select pg_temp.chk('... Bills spot_sell pnl +3329 - 3337, fee pnl -4', pg_temp.bills('A', 3) = 'spot_sell 3329 held 0 asset -0.333 pnl -8, fee -4 held 0 pnl -4', pg_temp.bills('A', 3));
select pg_temp.chk('... holding 0.5 basis 5012', pg_temp.hold('A') = '0.5/0/5012', pg_temp.hold('A'));
select pg_temp.snap('99.00', '99.10', now() - interval '61 seconds');
select pg_temp.chk('crossing but 61 s old: the limit rests (no PRICE_STALE)', v = 'open', v) from (select pg_temp.lim('A', 'buy', '0.333', '101.00', 4) v) s;
select pg_temp.chk('... holding ceil(3363.3) + 4 = 3368', (pg_temp.ord('A', 4)).hold_cents = 3368, (pg_temp.ord('A', 4)).hold_cents::text);
select pg_temp.chk('a market order on that snapshot -> PRICE_STALE', v ~ 'PRICE_STALE', v) from (select pg_temp.mkt('A', 'buy', '0.333', 5) v) s;
select pg_temp.reconcile();
SQL
;;
t3) cat <<'SQL'
-- T3 rest then fill through ingest_prices: at the limit price, no look-back, exact holds, one payout.
select pg_temp.snap('100.00', '100.10', now() - interval '50 seconds');
select pg_temp.chk('buy 0.333 at 99.99 rests', v = 'open', v) from (select pg_temp.lim('A', 'buy', '0.333', '99.99', 1) v) s;
update public.orders set created_at = now() - interval '45 seconds' where client_request_id = pg_temp.k(1);
select pg_temp.snap('99.00', '99.10', now() - interval '46 seconds');
select pg_temp.chk('a crossing snapshot older than the order fills nothing', pg_temp.match() = 0 and (pg_temp.ord('A', 1)).status = 'open', null);
select pg_temp.chk('ingest ask 100.10 above the limit: filled 0', v ->> 'accepted' = '1' and v ->> 'filled' = '0', v::text)
  from (select pg_temp.ingest('100.00', '100.10', now() - interval '40 seconds') v) s;
select pg_temp.chk('ingest ask 99.50 below the limit: filled 1', v ->> 'filled' = '1' and v ->> 'fill_errors' = '0', v::text)
  from (select pg_temp.ingest('99.40', '99.50', now() - interval '35 seconds') v) s;
select pg_temp.chk('... at the limit 99.99, not the ask; cost ceil(3329.667) = 3330, fee 4',
         (pg_temp.ord('A', 1)).status = 'filled' and (pg_temp.ord('A', 1)).price = 99.99 and (pg_temp.ord('A', 1)).notional_cents = 3330
         and (pg_temp.ord('A', 1)).fee_cents = 4 and (pg_temp.ord('A', 1)).price_at = now() - interval '35 seconds', (pg_temp.ord('A', 1))::text);
select pg_temp.chk('... paid exactly from the hold', pg_temp.bills('A', 1) = 'order_hold -3334 held 3334 pnl 0, spot_buy 0 held -3330 asset 0.333 pnl 0, fee 0 held -4 pnl 0', pg_temp.bills('A', 1));
select pg_temp.chk('... wallet 996666/0, holding 0.333 basis 3334', pg_temp.wal('A') = '996666/0' and pg_temp.hold('A') = '0.333/0/3334', pg_temp.wal('A') || ' ' || pg_temp.hold('A'));
select pg_temp.chk('a later crossing ingest pays nothing more', v ->> 'filled' = '0' and pg_temp.wal('A') = '996666/0', v::text)
  from (select pg_temp.ingest('99.30', '99.40', now() - interval '30 seconds') v) s;
select pg_temp.chk('sell 0.199 at 101.01 above the bid rests', v = 'open', v) from (select pg_temp.lim('A', 'sell', '0.199', '101.01', 2) v) s;
select pg_temp.chk('... moves 0.199 to held, no Bills row', pg_temp.hold('A') = '0.134/0.199/3334' and pg_temp.bills('A', 2) is null
         and (pg_temp.ord('A', 2)).hold_qty = 0.199 and (pg_temp.ord('A', 2)).hold_cents is null, pg_temp.hold('A'));
select pg_temp.chk('a market sell cannot use the held quantity', v ~ 'INSUFFICIENT_ASSET', v) from (select pg_temp.mkt('A', 'sell', '0.150', 3) v) s;
update public.orders set created_at = now() - interval '28 seconds' where client_request_id = pg_temp.k(2);
select pg_temp.chk('ingest bid 100.50 below the limit: filled 0', v ->> 'filled' = '0', v::text)
  from (select pg_temp.ingest('100.50', '100.60', now() - interval '25 seconds') v) s;
select pg_temp.chk('ingest bid 101.20 above the limit: filled 1', v ->> 'filled' = '1', v::text)
  from (select pg_temp.ingest('101.20', '101.30', now() - interval '20 seconds') v) s;
select pg_temp.chk('... at 101.01; proceeds floor(2010.099) = 2010, fee 3, basis out floor(3334 x 0.199 / 0.333) = 1992, pnl 15',
         (pg_temp.ord('A', 2)).price = 101.01 and (pg_temp.ord('A', 2)).notional_cents = 2010 and (pg_temp.ord('A', 2)).fee_cents = 3
         and (pg_temp.ord('A', 2)).realized_pnl_cents = 15, (pg_temp.ord('A', 2))::text);
select pg_temp.chk('... Bills spot_sell and fee', pg_temp.bills('A', 2) = 'spot_sell 2010 held 0 asset -0.199 pnl 18, fee -3 held 0 pnl -3', pg_temp.bills('A', 2));
select pg_temp.chk('... wallet 998673/0, holding 0.134 basis 1342', pg_temp.wal('A') = '998673/0' and pg_temp.hold('A') = '0.134/0/1342', pg_temp.wal('A') || ' ' || pg_temp.hold('A'));
select pg_temp.reconcile();
SQL
;;
t4) cat <<'SQL'
-- T4 cancel: releases the hold, a second cancel returns the row, only open own orders.
select pg_temp.snap('100.00', '100.10', now() - interval '30 seconds');
select pg_temp.chk('buy 0.333 at 99.99 rests', v = 'open', v) from (select pg_temp.lim('A', 'buy', '0.333', '99.99', 1) v) s;
select pg_temp.chk('cancel -> canceled', v = 'canceled' and (pg_temp.ord('A', 1)).canceled_at is not null, v) from (select pg_temp.cancel('A', 'A', 1) v) s;
select pg_temp.chk('... the hold comes back', pg_temp.wal('A') = '1000000/0'
         and pg_temp.bills('A', 1) = 'order_hold -3334 held 3334 pnl 0, order_release 3334 held -3334 pnl 0', pg_temp.wal('A') || ' ' || pg_temp.bills('A', 1));
select pg_temp.chk('a second cancel returns the canceled row and moves nothing', v = 'canceled' and pg_temp.wal('A') = '1000000/0'
         and (select count(*) from public.ledger l where l.ref_id = (pg_temp.ord('A', 1)).id) = 2, v) from (select pg_temp.cancel('A', 'A', 1) v) s;
select pg_temp.chk('a crossing ingest does not fill a canceled order', v ->> 'filled' = '0' and (pg_temp.ord('A', 1)).status = 'canceled', v::text)
  from (select pg_temp.ingest('99.00', '99.10', now() - interval '20 seconds') v) s;
select pg_temp.chk('market buy 1 at 99.10', v = 'filled' and pg_temp.hold('A') = '1/0/9920', v || ' ' || pg_temp.hold('A')) from (select pg_temp.mkt('A', 'buy', '1', 2) v) s;
select pg_temp.chk('sell 0.5 at 200.00 rests', v = 'open' and pg_temp.hold('A') = '0.5/0.5/9920', v || ' ' || pg_temp.hold('A')) from (select pg_temp.lim('A', 'sell', '0.5', '200.00', 3) v) s;
select pg_temp.chk('cancel the sell -> quantity back, no Bills row', v = 'canceled' and pg_temp.hold('A') = '1/0/9920' and pg_temp.bills('A', 3) is null, v || ' ' || pg_temp.hold('A'))
  from (select pg_temp.cancel('A', 'A', 3) v) s;
select pg_temp.chk('cancel a filled order -> ORDER_NOT_OPEN', v ~ 'ORDER_NOT_OPEN', v) from (select pg_temp.cancel('A', 'A', 2) v) s;
select pg_temp.chk('sell 0.5 at 200.00 rests again', v = 'open', v) from (select pg_temp.lim('A', 'sell', '0.5', '200.00', 4) v) s;
select pg_temp.chk('B cancels A''s order -> ORDER_NOT_FOUND', v ~ 'ORDER_NOT_FOUND' and (pg_temp.ord('A', 4)).status = 'open', v) from (select pg_temp.cancel('B', 'A', 4) v) s;
select pg_temp.chk('unknown order -> ORDER_NOT_FOUND', v ~ 'ORDER_NOT_FOUND', v)
  from (select pg_temp.as_user(pg_temp.u('A'), format('select (public.spot_cancel_order(%L)).status::text', gen_random_uuid())) v) s;
select pg_temp.reconcile();
SQL
;;
t5) cat <<'SQL'
-- T5 cap: 20 open orders per user; fills and other users are not limited by it.
select pg_temp.snap('100.00', '100.10', now());
select pg_temp.chk('20 resting buys', string_agg(distinct v, ',') = 'open' and count(*) = 20, string_agg(distinct v, ','))
  from (select pg_temp.lim('A', 'buy', '0.051', '99.99', n) v from generate_series(1, 20) n) s;
select pg_temp.chk('... each holds 510 + 1', pg_temp.wal('A') = (1000000 - 20 * 511) || '/' || (20 * 511), pg_temp.wal('A'));
select pg_temp.chk('the 21st -> OPEN_ORDERS_LIMIT max=20', v ~ 'OPEN_ORDERS_LIMIT detail=max=20', v) from (select pg_temp.lim('A', 'buy', '0.051', '99.99', 21) v) s;
select pg_temp.chk('a marketable limit still fills at the cap', v = 'filled', v) from (select pg_temp.lim('A', 'buy', '0.051', '101.00', 22) v) s;
select pg_temp.chk('B is not limited by A''s orders', v = 'open', v) from (select pg_temp.lim('B', 'buy', '0.051', '99.99', 1) v) s;
select pg_temp.chk('cancel one', v = 'canceled', v) from (select pg_temp.cancel('A', 'A', 1) v) s;
select pg_temp.chk('... then the 21st key rests', v = 'open', v) from (select pg_temp.lim('A', 'buy', '0.051', '99.99', 21) v) s;
select pg_temp.chk('... 20 open again', (select count(*) from public.orders where user_id = pg_temp.u('A') and status = 'open') = 20, null);
select pg_temp.reconcile();
SQL
;;
t6) cat <<'SQL'
-- T6 suspension: blocks placing, never fills; cancel still works.
select pg_temp.snap('100.00', '100.10', now() - interval '30 seconds');
select pg_temp.chk('C buy 0.333 at 99.99 rests', v = 'open', v) from (select pg_temp.lim('C', 'buy', '0.333', '99.99', 1) v) s;
select pg_temp.chk('C buy 0.333 at 99.98 rests', v = 'open', v) from (select pg_temp.lim('C', 'buy', '0.333', '99.98', 2) v) s;
-- Placed 25 s ago, so the ingest at -20 s is not a look-back.
update public.orders set created_at = now() - interval '25 seconds' where user_id = pg_temp.u('C');
update public.profiles set suspended_at = now() where id = pg_temp.u('C');
select pg_temp.chk('suspended: a new limit -> ACCOUNT_SUSPENDED', v ~ 'ACCOUNT_SUSPENDED', v) from (select pg_temp.lim('C', 'buy', '0.333', '99.97', 3) v) s;
select pg_temp.chk('suspended: a market order -> ACCOUNT_SUSPENDED', v ~ 'ACCOUNT_SUSPENDED', v) from (select pg_temp.mkt('C', 'buy', '0.333', 4) v) s;
select pg_temp.chk('suspended: cancel still works', v = 'canceled', v) from (select pg_temp.cancel('C', 'C', 2) v) s;
select pg_temp.chk('suspended: the resting order still fills', v ->> 'filled' = '1' and (pg_temp.ord('C', 1)).status = 'filled', v::text)
  from (select pg_temp.ingest('99.40', '99.50', now() - interval '20 seconds') v) s;
select pg_temp.chk('... wallet 96666/0, holding 0.333', pg_temp.wal('C') = '96666/0' and pg_temp.hold('C') = '0.333/0/3334', pg_temp.wal('C') || ' ' || pg_temp.hold('C'));
select pg_temp.reconcile();
SQL
;;
t7) cat <<'SQL'
-- T7 a failed fill stays open and the snapshot is kept; the safety net fills it; the cron job; the price tick claim.
select pg_temp.snap('100.00', '100.10', now() - interval '30 seconds');
select pg_temp.chk('two buys at 99.99 rest', string_agg(v, ',') = 'open,open', string_agg(v, ','))
  from (select pg_temp.lim('A', 'buy', '0.333', '99.99', n) v from generate_series(1, 2) n) s;
update public.orders set created_at = now() - interval '25 seconds' where user_id = pg_temp.u('A');
-- Break k2's hold record so its fill raises INVARIANT_HOLD_MISMATCH.
update public.orders set hold_cents = hold_cents + 1 where client_request_id = pg_temp.k(2);
select pg_temp.chk('ingest: k1 fills, k2 fails alone', v ->> 'accepted' = '1' and v ->> 'filled' = '1' and v ->> 'fill_errors' = '1', v::text)
  from (select pg_temp.ingest('99.40', '99.50', now() - interval '20 seconds') v) s;
select pg_temp.chk('... the snapshot is still written', (select fetched_at from public.price_snapshots where market_id = 'ZZT-USDT') = now() - interval '20 seconds', null);
select pg_temp.chk('... k1 filled, k2 still open with its hold', (pg_temp.ord('A', 1)).status = 'filled' and (pg_temp.ord('A', 2)).status = 'open'
         and pg_temp.wal('A') = (1000000 - 2 * 3334) || '/3334', pg_temp.wal('A'));
update public.orders set hold_cents = hold_cents - 1 where client_request_id = pg_temp.k(2);
select pg_temp.chk('the safety net fills k2 on the same fresh snapshot', v = 1, v::text) from (select pg_temp.match() v) s;
select pg_temp.chk('... k2 filled, nothing held', (pg_temp.ord('A', 2)).status = 'filled' and pg_temp.wal('A') = (1000000 - 2 * 3334) || '/0', pg_temp.wal('A'));
select pg_temp.chk('cron job aureonx-spot-match every minute', count(*) = 1, string_agg(schedule, ','))
  from cron.job where jobname = 'aureonx-spot-match' and schedule = '* * * * *' and command ~ 'fill_spot_orders';
select pg_temp.reconcile();
-- price_tick claim, only when no demand window or open options position keeps the feed on anyway.
update public.system_state set price_demand_until = '-infinity', limit_tick_at = '-infinity';
select pg_temp.chk('sell 0.1 at 500.00 rests', v = 'open', v) from (select pg_temp.lim('A', 'sell', '0.1', '500.00', 3) v) s;
create function pg_temp.tick_chk(p_label text, p_ok boolean) returns void language sql as $f$
  select pg_temp.chk(p_label || case when s.busy then ' (skipped: the feed is on for an open options position)' else '' end, s.busy or p_ok, null)
    from (select exists (select 1 from public.options_positions where status = 'open') busy) s $f$;
select private.price_tick();
select pg_temp.tick_chk('price_tick with only an open limit order claims the minute', (select limit_tick_at from public.system_state) = now());
update public.system_state set limit_tick_at = now() - interval '50 seconds';
select private.price_tick();
select pg_temp.tick_chk('... 50 s later it does not fire again', (select limit_tick_at from public.system_state) = now() - interval '50 seconds');
update public.system_state set limit_tick_at = now() - interval '56 seconds';
select private.price_tick();
select pg_temp.tick_chk('... 56 s later it fires', (select limit_tick_at from public.system_state) = now());
SQL
;;
*) echo "unknown step $1" >&2; return 1;;
esac
}

steps=("$@"); [ ${#steps[@]} -eq 0 ] && steps=(t1 t2 t3 t4 t5 t6 t7)
for s in "${steps[@]}"; do
  echo "== $s"
  sql=$(body "$s") || { FAILS=$((FAILS+1)); continue; }
  out=$(printf '%s\n%s\n%s\n' "$PRELUDE" "$sql" "$FINALE" | run)
  res=$(printf '%s' "$out" | jq -r '.message // empty' 2>/dev/null | sed -n 's/.*SPOTTEST //p' | head -1)
  if [ -z "$res" ]; then echo "FAIL $s did not finish: $out"; FAILS=$((FAILS+1)); continue; fi
  printf '%s' "$res" | jq -r '.[] | if .ok then "PASS " + .l else "FAIL " + .l + " (got: " + (.got // "null") + ")" end'
  FAILS=$((FAILS + $(printf '%s' "$res" | jq '[.[] | select(.ok | not)] | length')))
done
echo "failures: $FAILS"
exit $FAILS
