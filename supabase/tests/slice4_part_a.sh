#!/bin/bash
# Slice 4 Part A tests. Prints only query results / error messages (no keys).
# Usage: supabase/tests/slice4_part_a.sh setup|t1|...|t11|cleanup  (Management API, write token required)
# Test snapshots are inserted as postgres with a fixed price (BTC bid 50000.00 / ask 50000.10)
# so the cent math is predictable. cleanup deletes them and the temporary users.
# The project comes from SUPABASE_PROJECT_REF; abort before any query unless it
# matches the ref in NEXT_PUBLIC_SUPABASE_URL.
REF=${SUPABASE_PROJECT_REF:?SUPABASE_PROJECT_REF is not set}
URL_REF=$(printf '%s' "${NEXT_PUBLIC_SUPABASE_URL:-}" | sed -nE 's#^https://([a-z0-9]+)\.supabase\.co/?$#\1#p')
if [ "$REF" != "$URL_REF" ]; then echo "SUPABASE_PROJECT_REF does not match NEXT_PUBLIC_SUPABASE_URL; aborting." >&2; exit 1; fi
A=aaaaaaaa-0000-4000-8000-00000000004a   # trader
B=bbbbbbbb-0000-4000-8000-00000000004b   # another user (RLS check)
TMP=${TMPDIR:-/tmp}
run() { jq -Rs '{query: ., read_only: false}' | curl -sS -X POST "https://api.supabase.com/v1/projects/$REF/database/query" -H 'Content-Type: application/json' --data-binary @-; echo; }
# as <uid> <sql>
as() { run <<SQL
begin;
select set_config('request.jwt.claims', json_build_object('sub','$1','role','authenticated','aal','aal1','user_role','user')::text, true);
set local role authenticated;
$2
commit;
SQL
}
snap() { run <<SQL
insert into public.price_snapshots (market_id, bid, ask, fetched_at, source)
values ('BTC-USDT', 50000.00, 50000.10, now() - interval '$1 seconds', 'vision')
on conflict (market_id) do update set bid = excluded.bid, ask = excluded.ask,
  fetched_at = excluded.fetched_at, source = excluded.source, ingested_at = now();
select 'snapshot age $1 s' ok;
SQL
}
state() { run <<SQL
select w.available_cents spot_cents,
       (select available_qty::text from public.spot_holdings where user_id='$A' and asset='BTC') btc,
       (select cost_basis_cents from public.spot_holdings where user_id='$A' and asset='BTC') basis_cents,
       (select count(*) from public.orders where user_id='$A') orders,
       (select count(*) from public.ledger where user_id='$A' and ref_type='order') order_rows
from public.wallets w where w.user_id='$A' and w.account='spot';
SQL
}
case "$1" in
setup) run <<SQL
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000','$A','authenticated','authenticated','slice4-test-a@aureonx.invalid','',now(),'{}','{"nickname":"TestA"}',now(),now()),
       ('00000000-0000-0000-0000-000000000000','$B','authenticated','authenticated','slice4-test-b@aureonx.invalid','',now(),'{}','{"nickname":"TestB"}',now(),now());
select private.wallet_apply((select id from public.wallets where user_id='$A' and account='spot'),
  100000, 0, 'admin_credit', 'admin_adjustment', gen_random_uuid(), p_memo => 'Balance adjustment');
select account, available_cents from public.wallets where user_id='$A' order by account;
SQL
;;
t1) echo "T1 buy 0.001 BTC at ask 50000.10: cost ceil(5000.01)=5001, fee ceil(5.001)=6"; snap 1
    as $A "select side, qty::text, price::text, notional_cents, fee_cents from public.spot_market_order('BTC-USDT','buy','0.001',gen_random_uuid());"
    run <<SQL
select kind, delta_cents, asset, asset_delta::text, pnl_cents, memo from public.ledger
where user_id='$A' and ref_type='order' order by id;
SQL
    state;;
t2) echo "T2 40 parallel buys of 0.0006 BTC (3001 + fee 4 = 3005 each) against 949.93"; snap 1
    for i in $(seq 1 40); do (as $A "select (public.spot_market_order('BTC-USDT','buy','0.0006',gen_random_uuid())).notional_cents ok;" > $TMP/slice4.p$i.out) & done
    wait; cat $TMP/slice4.p*.out | sed -E 's/.*"ok":([0-9]+).*/ok \1/; s/.*(INSUFFICIENT_FUNDS|deadlock[^"]*).*/fail \1/' | sort | uniq -c; rm -f $TMP/slice4.p*.out
    state
    run <<SQL
select (select available_cents from public.wallets where user_id='$A' and account='spot') wallet,
       (select sum(delta_cents) from public.ledger where user_id='$A' and account='spot') ledger_sum,
       (select count(*) from public.ledger where user_id='$A' and balance_after_cents < 0) negatives,
       (select sum(asset_delta)::text from public.ledger where user_id='$A' and asset='BTC') ledger_btc;
SQL
;;
t3) echo "T3 sell more than the holding, then a valid sell of 0.0096"; snap 1
    as $A "select public.spot_market_order('BTC-USDT','sell','0.02',gen_random_uuid());"
    as $A "select side, qty::text, price::text, notional_cents, fee_cents, realized_pnl_cents from public.spot_market_order('BTC-USDT','sell','0.0096',gen_random_uuid());"
    run <<SQL
select kind, delta_cents, asset_delta::text, pnl_cents, memo from public.ledger
where user_id='$A' and ref_type='order' order by id desc limit 2;
SQL
    state;;
t4) echo "T4 stale snapshot (61 s) refused; 55 s accepted; a market with no snapshot refused"; snap 61
    as $A "select public.spot_market_order('BTC-USDT','buy','0.0002',gen_random_uuid());"
    snap 55
    as $A "select (public.spot_market_order('BTC-USDT','buy','0.0002',gen_random_uuid())).notional_cents ok;"
    as $A "select public.spot_market_order('ETH-USDT','buy','0.01',gen_random_uuid());";;
t5) echo "T5 below the minimum order value (0.00009 BTC = 4.50 < 5.00)"; snap 1
    as $A "select public.spot_market_order('BTC-USDT','buy','0.00009',gen_random_uuid());"
    echo "T5b exactly 5.00 at the bid is allowed (0.0001 x 50000.00)"
    as $A "select (public.spot_market_order('BTC-USDT','sell','0.0001',gen_random_uuid())).notional_cents ok;";;
t6) echo "T6 too many decimals (BTC allows 5) and malformed numbers"; snap 1
    for q in 0.000011 1e-3 -0.001 0x10 abc "" NaN Infinity " 0.001"; do
      as $A "select public.spot_market_order('BTC-USDT','buy','$q',gen_random_uuid());" | sed "s/^/[$q] /"; done
    as $A "select public.spot_market_order('BTC-USDT','buy',null,gen_random_uuid());" | sed "s/^/[null] /"
    as $A "select public.spot_market_order('BTC-USDT','buy','0',gen_random_uuid());" | sed "s/^/[0] /"
    as $A "select public.spot_market_order('NOPE-USDT','buy','1',gen_random_uuid());" | sed "s/^/[market] /";;
t7) echo "T7 same key twice fills once; changed parameters refused"; snap 1; K=44444444-0000-4000-8000-000000000001
    as $A "select id, notional_cents from public.spot_market_order('BTC-USDT','buy','0.0002','$K');"
    as $A "select id, notional_cents from public.spot_market_order('BTC-USDT','buy','0.00020','$K');"
    as $A "select public.spot_market_order('BTC-USDT','buy','0.0003','$K');"
    as $A "select public.spot_market_order('BTC-USDT','sell','0.0002','$K');"
    as $A "select public.spot_market_order('ETH-USDT','buy','0.0002','$K');"
    run <<SQL
select (select count(*) from public.orders where client_request_id='$K') orders,
       (select count(*) from public.ledger where ref_id=(select id from public.orders where client_request_id='$K')) bills_rows;
SQL
;;
t8) echo "T8 direct writes as the user are denied"
    as $A "insert into public.orders (user_id, wallet_id, market_id, side, qty, price, price_at, price_source, notional_cents, fee_bps, fee_cents, client_request_id) select '$A', id, 'BTC-USDT', 'buy', 1, 1, now(), 'vision', 100, 0, 0, gen_random_uuid() from public.wallets where user_id='$A' and account='spot';"
    as $A "update public.orders set qty = 100 where user_id='$A';"
    as $A "delete from public.orders where user_id='$A';"
    as $A "insert into public.spot_holdings (user_id, asset, available_qty) values ('$A','ETH',100);"
    as $A "update public.spot_holdings set available_qty = 100 where user_id='$A';"
    as $A "insert into public.price_snapshots (market_id, bid, ask, fetched_at, source) values ('ETH-USDT',1,1,now(),'vision');"
    as $A "update public.spot_config set fee_bps = 0;"
    as $A "select * from public.system_state;"
    as $A "select public.ingest_prices('[]'::jsonb);"
    as $A "select private.holding_apply('$A','BTC',1,0);"
    echo "T8b service_role direct balance write hits the guard trigger"
    run <<SQL
begin; set local role service_role; update public.spot_holdings set available_qty = 100 where user_id='$A'; commit;
SQL
    echo "T8c RLS: B sees none of A's rows; A sees own; anon sees nothing"
    as $B "select (select count(*) from public.orders) orders, (select count(*) from public.spot_holdings) holdings, (select count(*) from public.spot_config) config, (select count(*) from public.price_snapshots) snaps;"
    as $A "select (select count(*) from public.orders) orders, (select count(*) from public.spot_holdings) holdings;"
    run <<SQL
begin; set local role anon; select count(*) from public.orders; commit;
SQL
    run <<SQL
begin; set local role anon; select count(*) from public.spot_holdings; commit;
SQL
;;
t9) echo "T9 spot_market_order has no price parameter"; run <<SQL
select p.oid::regprocedure signature, pg_get_function_identity_arguments(p.oid) args
from pg_proc p where p.proname = 'spot_market_order';
SQL
;;
t10) echo "T10 ingest_prices as service_role: validation and forward-only upsert (rolled back)"; run <<SQL
begin; set local role service_role;
select public.ingest_prices(jsonb_build_array(
  jsonb_build_object('market_id','ETH-USDT','bid','2000.10','ask','2000.20','source','vision','ts', now()),
  jsonb_build_object('market_id','ETH-USDT','bid','2000.30','ask','2000.20','source','vision','ts', now()),
  jsonb_build_object('market_id','SOL-USDT','bid','NaN','ask','1','source','vision','ts', now()),
  jsonb_build_object('market_id','SOL-USDT','bid', 1, 'ask','2','source','vision','ts', now()),
  jsonb_build_object('market_id','SOL-USDT','bid','0','ask','2','source','vision','ts', now()),
  jsonb_build_object('market_id','SOL-USDT','bid','1','ask','2','source','vision','ts', now() - interval '61 seconds'),
  jsonb_build_object('market_id','SOL-USDT','bid','1','ask','2','source','vision','ts', now() + interval '6 seconds'),
  jsonb_build_object('market_id','SOL-USDT','bid','1','ask','2','source','other','ts', now()),
  jsonb_build_object('market_id','SOL-USDT','bid','1','ask','2','source','vision'),
  jsonb_build_object('market_id','NOPE-USDT','bid','1','ask','2','source','vision','ts', now())
)) result;
rollback;
SQL
    echo "T10b an older timestamp never overwrites a newer snapshot and is reported as ignored (one transaction, so now() is fixed; rolled back)"
    run <<SQL
begin; set local role service_role;
create temp table r (k text, v jsonb) on commit drop;
insert into r select 'newer', public.ingest_prices(jsonb_build_array(jsonb_build_object('market_id','ETH-USDT','bid','2000.10','ask','2000.20','source','vision','ts', now())));
insert into r select 'older', public.ingest_prices(jsonb_build_array(jsonb_build_object('market_id','ETH-USDT','bid','1.00','ask','1.01','source','kucoin','ts', now() - interval '20 seconds')));
reset role;
select k, v, (select bid::text from public.price_snapshots where market_id='ETH-USDT') kept_bid from r;
rollback;
SQL
;;
t11) echo "T11 demand: user heartbeat opens the window; anon cannot; tick with no Vault secrets sends nothing"
    as $A "select public.request_price_feed() > now() + interval '4 minutes' window_open;"
    run <<SQL
begin; set local role anon; select public.request_price_feed(); commit;
SQL
    # The query endpoint returns only the last statement's result, so these run one by one.
    echo "select (select count(*) from net.http_request_queue) queued_before;" | run
    echo "select private.price_tick();" | run
    echo "select (select count(*) from net.http_request_queue) queued_after;" | run
    echo "update public.system_state set price_demand_until = '-infinity' where id; select price_demand_until from public.system_state;" | run
;;
cleanup) run <<SQL
delete from public.price_snapshots where market_id in ('BTC-USDT','ETH-USDT','SOL-USDT');
delete from auth.users where id in ('$A','$B');
update public.system_state set price_demand_until = '-infinity' where id;
select (select count(*) from public.profiles where id in ('$A','$B')) profiles,
       (select count(*) from public.orders) orders, (select count(*) from public.spot_holdings) holdings,
       (select count(*) from public.price_snapshots) snapshots;
SQL
;;
*) echo "usage: $0 setup|t1..t11|cleanup"; exit 1;;
esac
