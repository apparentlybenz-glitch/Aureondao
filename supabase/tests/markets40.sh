#!/bin/bash
# Tests for 20261030120000_markets_40: the 40 markets, Options on 38 of them (not SHIB or
# PEPE), an Options position on a coarse-tick pair (OP), and Spot on SHIB. Prints PASS/FAIL lines (no keys) and exits non-zero if any
# check fails.
# Usage: supabase/tests/markets40.sh [t1 ... t3]  (Management API, write token required;
# run it only after the migration is applied)
# Always runs setup, the given steps (all by default), then cleanup, in one process.
# setup pauses the aureonx-price-tick and aureonx-options-void cron jobs so live prices never
# settle a test position and the test calls settlement itself. A trap on EXIT, INT, TERM and
# ERR runs cleanup, which turns both jobs back on, deletes the test user and the OP, SHIB and
# PEPE test snapshots. Test snapshots are written as postgres with fixed prices.
# The project comes from SUPABASE_PROJECT_REF; abort before any query unless it matches the
# ref in NEXT_PUBLIC_SUPABASE_URL.
REF=${SUPABASE_PROJECT_REF:?SUPABASE_PROJECT_REF is not set}
URL_REF=$(printf '%s' "${NEXT_PUBLIC_SUPABASE_URL:-}" | sed -nE 's#^https://([a-z0-9]+)\.supabase\.co/?$#\1#p')
if [ "$REF" != "$URL_REF" ]; then echo "SUPABASE_PROJECT_REF does not match NEXT_PUBLIC_SUPABASE_URL; aborting." >&2; exit 1; fi
A=aaaaaaaa-0000-4000-8000-0000000000a1   # trader, options wallet 3,000.00
FAILS=0
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
expect() { if printf '%s' "$3" | grep -Eq "$2"; then echo "PASS $1"; else echo "FAIL $1 (expected /$2/): $3"; FAILS=$((FAILS+1)); fi; }
# snap <market> <bid> <ask> <age s>
snap() { run <<SQL
insert into public.price_snapshots (market_id, bid, ask, fetched_at, source)
values ('$1', $2, $3, now() - interval '$4 seconds', 'vision')
on conflict (market_id) do update set bid = excluded.bid, ask = excluded.ask,
  fetched_at = excluded.fetched_at, source = excluded.source, ingested_at = now();
select '$1 snapshot ok' ok;
SQL
}
# ingest <market> <bid> <ask>: the Edge Function's path (service_role), which settles.
ingest() { run <<SQL
begin; set local role service_role;
select public.ingest_prices(jsonb_build_array(jsonb_build_object('market_id','$1','bid','$2','ask','$3',
  'source','vision','ts', now()))) ingest;
commit;
SQL
}
job() { echo "select cron.alter_job((select jobid from cron.job where jobname = '$1'), active := $2); select 1 ok;" | run > /dev/null; }
key() { printf '66666666-0000-4000-8000-%012d' "$1"; }
position() { run <<SQL
select p.market_id, p.status, p.result, p.entry_price::text entry, p.settle_price::text settle, p.payout_cents, p.fee_cents
from public.options_positions p where p.client_request_id = '$1';
SQL
}

step() {
case "$1" in
setup) run <<SQL
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000','$A','authenticated','authenticated','markets40-test-a@aureonx.invalid','',now(),'{}','{"nickname":"TestA"}',now(),now());
select private.wallet_apply((select id from public.wallets where user_id='$A' and account='options'),
  300000, 0, 'admin_credit', 'admin_adjustment', gen_random_uuid(), p_memo => 'Balance adjustment');
select 1 ok;
SQL
    job aureonx-price-tick false; job aureonx-options-void false;;
t1) echo "T1 catalog: 40 enabled markets, Options on 38 (not SHIB or PEPE), complete metadata, unique sort order"
    out=$(echo "select count(*) filter (where enabled) enabled, count(*) filter (where enabled and options_enabled) options,
      count(distinct sort_order) sorts, count(*) filter (where qty_decimals is null or min_notional_cents is null or price_decimals is null) missing,
      count(*) filter (where vision_symbol <> base || 'USDT' or kucoin_symbol <> base || '-USDT' or display_symbol <> base || 'USD') naming
      from public.markets;" | run)
    expect "40 enabled markets" '"enabled":40' "$out"
    expect "Options on 38" '"options":38' "$out"
    expect "40 distinct sort orders" '"sorts":40' "$out"
    expect "no missing metadata" '"missing":0' "$out"
    expect "symbol naming follows the seeded rows" '"naming":0' "$out"
    out=$(echo "select id, options_enabled from public.markets where id in ('SHIB-USDT','PEPE-USDT','OP-USDT') order by id;" | run)
    expect "OP has Options" '"id":"OP-USDT","options_enabled":true' "$out"
    expect "SHIB has no Options" '"id":"SHIB-USDT","options_enabled":false' "$out"
    expect "PEPE has no Options" '"id":"PEPE-USDT","options_enabled":false' "$out"
    out=$(echo "select id, price_decimals pd, qty_decimals qd, min_notional_cents mn from public.markets where id in ('SHIB-USDT','BCH-USDT','HBAR-USDT','SEI-USDT') order by id;" | run)
    expect "SHIB 8 / 0 / 100" '"id":"SHIB-USDT","pd":8,"qd":0,"mn":100' "$out"
    expect "BCH 1 / 3 / 500" '"id":"BCH-USDT","pd":1,"qd":3,"mn":500' "$out"
    expect "HBAR 5 / 0 / 500" '"id":"HBAR-USDT","pd":5,"qd":0,"mn":500' "$out"
    expect "SEI 5 / 1 / 500" '"id":"SEI-USDT","pd":5,"qd":1,"mn":500' "$out";;
t2) echo "T2 Options on OP (coarse tick): entry is the exact half-tick mid, a rise wins, equal mids draw; SHIB and PEPE are refused"
    snap OP-USDT 0.0983 0.0985 1 > /dev/null
    out=$(as $A "select public.open_option('OP-USDT','rise',30,4900,'$(key 1)') opened, public.open_option('OP-USDT','fall',30,4900,'$(key 2)') opened2;")
    expect "positions opened on OP" '"opened"' "$out"
    echo "update public.options_positions set created_at = created_at - interval '40 seconds', expires_at = expires_at - interval '40 seconds',
      entry_price_at = entry_price_at - interval '40 seconds' where user_id = '$A' and status = 'open'; select 1 ok;" | run > /dev/null
    ingest OP-USDT 0.0984 0.0986 > /dev/null
    out=$(position "$(key 1)")
    expect "entry mid is 0.0984 exactly" '"entry":"0.0984' "$out"
    expect "rise wins at settle mid 0.0985" '"result":"win","settle":"0.0985' "$out"
    expect "win pays 4900 + 294" '"payout_cents":5194' "$out"
    out=$(position "$(key 2)")
    expect "fall loses" '"result":"loss"' "$out"
    snap OP-USDT 0.0983 0.0985 1 > /dev/null
    as $A "select public.open_option('OP-USDT','rise',30,4900,'$(key 3)');" > /dev/null
    echo "update public.options_positions set created_at = created_at - interval '40 seconds', expires_at = expires_at - interval '40 seconds',
      entry_price_at = entry_price_at - interval '40 seconds' where client_request_id = '$(key 3)'; select 1 ok;" | run > /dev/null
    ingest OP-USDT 0.0983 0.0985 > /dev/null
    out=$(position "$(key 3)")
    expect "equal mids draw and refund the premium" '"result":"draw".*"payout_cents":4900' "$out"
    for m in SHIB-USDT PEPE-USDT; do
      out=$(as $A "select public.open_option('$m','rise',30,4900,gen_random_uuid());")
      expect "open_option on $m is refused with MARKET_DISABLED" 'MARKET_DISABLED' "$out"
    done;;
t3) echo "T3 Spot on SHIB: minimum is 1 USDT, quantities are whole units"
    echo "select private.wallet_apply((select id from public.wallets where user_id='$A' and account='spot'), 100000, 0, 'admin_credit', 'admin_adjustment', gen_random_uuid(), p_memo => 'Balance adjustment'); select 1 ok;" | run > /dev/null
    snap SHIB-USDT 0.00000451 0.00000452 1 > /dev/null
    out=$(as $A "select public.spot_market_order('SHIB-USDT','buy','100000',gen_random_uuid());")
    expect "100000 SHIB (0.45 USDT) is below the 1 USDT minimum" 'BELOW_MIN_NOTIONAL' "$out"
    out=$(as $A "select public.spot_market_order('SHIB-USDT','buy','221000.5',gen_random_uuid());")
    expect "a fractional SHIB quantity is refused" 'INVALID_QTY' "$out"
    out=$(as $A "select side, qty::text, price::text, notional_cents from public.spot_market_order('SHIB-USDT','buy','222000',gen_random_uuid());")
    expect "222000 SHIB buys at the ask 0.00000452 for 101 cents" '"qty":"222000[0.]*","price":"0.00000452[0]*","notional_cents":101' "$out";;
cleanup) job aureonx-price-tick true; job aureonx-options-void true; run <<SQL
delete from auth.users where id = '$A';
delete from public.price_snapshots where market_id in ('OP-USDT','SHIB-USDT','PEPE-USDT');
update public.system_state set price_demand_until = '-infinity' where id;
select (select count(*) from public.profiles where id = '$A') profiles;
SQL
;;
*) echo "unknown step $1"; exit 1;;
esac
}

restore() { trap - EXIT INT TERM ERR; step cleanup; }
trap restore EXIT
trap 'restore; exit 130' INT
trap 'restore; exit 143' TERM
trap 'restore; exit 1' ERR

steps=("$@"); [ ${#steps[@]} -eq 0 ] && steps=(t1 t2 t3)
step setup
for s in "${steps[@]}"; do step "$s"; echo; done
if [ $FAILS -gt 0 ]; then echo "$FAILS check(s) failed"; exit 1; fi
echo "all checks passed"
