#!/bin/bash
# Day 6 migration tests (20261027140000_day6_bugfixes). Prints only query results / error messages.
# Usage: supabase/tests/day6_bugfixes.sh [t1 ... t4]  (Management API, write token required)
# Always runs setup, the given steps (all by default), then cleanup, in one process; a trap on
# EXIT, INT, TERM and ERR runs cleanup. Cleanup closes the price demand window and removes the
# test snapshots (the live feed refills both on the next heartbeat), re-enables BTC-USDT and
# deletes the test user.
# The project comes from SUPABASE_PROJECT_REF; abort before any query unless it
# matches the ref in NEXT_PUBLIC_SUPABASE_URL.
REF=${SUPABASE_PROJECT_REF:?SUPABASE_PROJECT_REF is not set}
URL_REF=$(printf '%s' "${NEXT_PUBLIC_SUPABASE_URL:-}" | sed -nE 's#^https://([a-z0-9]+)\.supabase\.co/?$#\1#p')
if [ "$REF" != "$URL_REF" ]; then echo "SUPABASE_PROJECT_REF does not match NEXT_PUBLIC_SUPABASE_URL; aborting." >&2; exit 1; fi
A=aaaaaaaa-0000-4000-8000-00000000006a
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
values ('BTC-USDT', 50000.00, 50000.10, now() - interval '1 seconds', 'vision')
on conflict (market_id) do update set bid = excluded.bid, ask = excluded.ask,
  fetched_at = excluded.fetched_at, source = excluded.source, ingested_at = now();
select 'snapshot ok' ok;
SQL
}
setup() { run <<SQL
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000','$A','authenticated','authenticated','day6-test-a@aureonx.invalid','',now(),'{}','{"nickname":"TestA"}',now(),now());
select private.wallet_apply((select id from public.wallets where user_id='$A' and account='spot'),
  100000, 0, 'admin_credit', 'admin_adjustment', gen_random_uuid(), p_memo => 'Balance adjustment');
SQL
}
cleanup() { run <<SQL
update public.markets set enabled = true where id = 'BTC-USDT';
delete from public.price_snapshots where market_id = 'BTC-USDT';
delete from auth.users where id = '$A';
update public.system_state set price_demand_until = '-infinity' where id;
select (select count(*) from public.profiles where id = '$A') profiles,
       (select enabled from public.markets where id = 'BTC-USDT') btc_enabled;
SQL
}
trap cleanup EXIT INT TERM ERR
echo "== setup"; setup
steps=("$@"); [ ${#steps[@]} -eq 0 ] && steps=(t1 t2 t3 t4)
for s in "${steps[@]}"; do
case "$s" in
t1) echo "T1 throttle: first call opens the window; a call within 30 s changes nothing; after 31 s it opens again"
    as $A "select public.request_price_feed() > now() + interval '4 minutes' window_open;"
    echo "update public.system_state set price_demand_until = '-infinity' where id; select 1 ok;" | run
    as $A "select public.request_price_feed() is not distinct from '-infinity'::timestamptz returned_current_window;"
    echo "select (select price_demand_until from public.system_state where id) demand_after_throttled_call;" | run
    echo "update public.profiles set price_feed_requested_at = now() - interval '31 seconds' where id = '$A'; select 1 ok;" | run
    as $A "select public.request_price_feed() > now() + interval '4 minutes' window_open_again;"
    echo "T1b anon cannot call it"; echo "begin; set local role anon; select public.request_price_feed(); commit;" | run;;
t2) echo "T2 replay after the market is disabled returns the original order; a new key is refused"
    snap
    K=66666666-0000-4000-8000-000000000001
    as $A "select id, notional_cents from public.spot_market_order('BTC-USDT','buy','0.001','$K');"
    echo "update public.markets set enabled = false where id = 'BTC-USDT'; select 1 ok;" | run
    as $A "select id, notional_cents from public.spot_market_order('BTC-USDT','buy','0.001','$K');"
    as $A "select * from public.spot_market_order('BTC-USDT','buy','0.001',gen_random_uuid());"
    as $A "select * from public.spot_market_order('BTC-USDT','buy','0.002','$K');"
    echo "update public.markets set enabled = true where id = 'BTC-USDT'; select count(*) orders from public.orders where user_id = '$A';" | run;;
t3) echo "T3 premium cap: 100000000001 is INVALID_AMOUNT; 100000000000 gets past it (INSUFFICIENT_FUNDS)"
    snap
    as $A "select public.open_option('BTC-USDT','rise',30,100000000001,gen_random_uuid());"
    as $A "select public.open_option('BTC-USDT','rise',30,100000000000,gen_random_uuid());";;
t4) echo "T4 catalog: sequence grants, publication, indexes, function grants"
    run <<SQL
select 'seq' k, coalesce(relacl::text,'') v from pg_class where relname = 'ledger_id_seq'
union all select 'pub', string_agg(tablename::text, ',' order by tablename) from pg_publication_tables where pubname = 'supabase_realtime'
union all select 'idx', string_agg(indexname::text, ',' order by indexname) from pg_indexes where schemaname = 'public' and indexname in ('orders_wallet_market_idx','transfers_from_to_wallet_idx')
union all select 'fn', p.oid::regprocedure::text || ' anon=' || has_function_privilege('anon', p.oid, 'execute') || ' authenticated=' || has_function_privilege('authenticated', p.oid, 'execute')
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('request_price_feed','open_option','spot_market_order');
SQL
;;
*) echo "usage: $0 [t1 ... t4]"; exit 1;;
esac
done
echo "== cleanup"
