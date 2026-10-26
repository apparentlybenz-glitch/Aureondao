#!/bin/bash
# Slice 5 Part A tests (options). Prints only query results / error messages (no keys).
# Usage: supabase/tests/slice5_part_a.sh [t1 ... t11]  (Management API, write token required)
# Always runs setup, the given steps (all by default), then cleanup, in one process.
# setup pauses the aureonx-price-tick and aureonx-options-void cron jobs so live prices
# never settle a test position and the tests call settlement and voiding themselves.
# A trap on EXIT, INT, TERM and ERR runs cleanup, which turns both jobs back on and
# deletes the test users, so production is restored however the run ends. Test snapshots are written as postgres with fixed prices
# (BTC 50000.00 / 50000.10, mid 50000.05) so the cent math is predictable.
# The project comes from SUPABASE_PROJECT_REF; abort before any query unless it
# matches the ref in NEXT_PUBLIC_SUPABASE_URL.
REF=${SUPABASE_PROJECT_REF:?SUPABASE_PROJECT_REF is not set}
URL_REF=$(printf '%s' "${NEXT_PUBLIC_SUPABASE_URL:-}" | sed -nE 's#^https://([a-z0-9]+)\.supabase\.co/?$#\1#p')
if [ "$REF" != "$URL_REF" ]; then echo "SUPABASE_PROJECT_REF does not match NEXT_PUBLIC_SUPABASE_URL; aborting." >&2; exit 1; fi
A=aaaaaaaa-0000-4000-8000-00000000005a   # trader, options wallet 30,000.00
B=bbbbbbbb-0000-4000-8000-00000000005b   # admin
C=cccccccc-0000-4000-8000-00000000005c   # options wallet 49.00: covers the minimum premium, not the fee
TMP=${TMPDIR:-/tmp}
run() { jq -Rs '{query: ., read_only: false}' | curl -sS -X POST "https://api.supabase.com/v1/projects/$REF/database/query" -H 'Content-Type: application/json' --data-binary @-; echo; }
# as <uid> <aal> <user_role> <sql>
as() { run <<SQL
begin;
select set_config('request.jwt.claims', json_build_object('sub','$1','role','authenticated','aal','$2','user_role','$3')::text, true);
set local role authenticated;
$4
commit;
SQL
}
user() { as "$1" aal1 user "$2"; }
# snap <market> <bid> <ask> <age s>: write a snapshot directly (no settlement).
snap() { run <<SQL
insert into public.price_snapshots (market_id, bid, ask, fetched_at, source)
values ('$1', $2, $3, now() - interval '$4 seconds', 'vision')
on conflict (market_id) do update set bid = excluded.bid, ask = excluded.ask,
  fetched_at = excluded.fetched_at, source = excluded.source, ingested_at = now();
select '$1 snapshot age $4 s' ok;
SQL
}
# ingest <market> <bid> <ask> <age s>: the Edge Function's path (service_role), which settles.
ingest() { run <<SQL
begin; set local role service_role;
select public.ingest_prices(jsonb_build_array(jsonb_build_object('market_id','$1','bid','$2','ask','$3',
  'source','vision','ts', now() - interval '$4 seconds'))) ingest;
commit;
SQL
}
# shift <where>: move created_at and expires_at back (test-only), keeping expires = created + duration.
shift() { run <<SQL
update public.options_positions set created_at = created_at - interval '$1 seconds',
  expires_at = expires_at - interval '$1 seconds', entry_price_at = entry_price_at - interval '$1 seconds'
where user_id = '$A' and status = 'open' and $2;
select count(*) shifted from public.options_positions where user_id = '$A' and $2;
SQL
}
job() { echo "select cron.alter_job((select jobid from cron.job where jobname = '$1'), active := $2); select jobname, active from cron.job where jobname = '$1';" | run; }
key() { printf '55555555-0000-4000-8000-%012d' "$1"; }
show() { run <<SQL
select p.client_request_id, p.direction, p.premium_cents, p.fee_cents, p.entry_price::text entry, p.status, p.result,
       p.settle_price::text settle, p.payout_cents,
       (select sum(l.pnl_cents) from public.ledger l where l.ref_id = p.id) pnl_sum,
       p.payout_cents - p.premium_cents - p.fee_cents expected_pnl,
       (select string_agg(l.kind || ' ' || l.delta_cents || ' pnl ' || l.pnl_cents, ', ' order by l.id)
          from public.ledger l where l.ref_id = p.id) bills
from public.options_positions p where p.client_request_id in ($1) order by p.client_request_id;
SQL
}

step() {
case "$1" in
setup) run <<SQL
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000','$A','authenticated','authenticated','slice5-test-a@aureonx.invalid','',now(),'{}','{"nickname":"TestA"}',now(),now()),
       ('00000000-0000-0000-0000-000000000000','$B','authenticated','authenticated','slice5-test-b@aureonx.invalid','',now(),'{}','{"nickname":"TestB"}',now(),now()),
       ('00000000-0000-0000-0000-000000000000','$C','authenticated','authenticated','slice5-test-c@aureonx.invalid','',now(),'{}','{"nickname":"TestC"}',now(),now());
insert into public.user_roles (user_id, role) values ('$B','admin');
select private.wallet_apply((select id from public.wallets where user_id='$A' and account='options'),
  3000000, 0, 'admin_credit', 'admin_adjustment', gen_random_uuid(), p_memo => 'Balance adjustment');
select private.wallet_apply((select id from public.wallets where user_id='$C' and account='options'),
  4900, 0, 'admin_credit', 'admin_adjustment', gen_random_uuid(), p_memo => 'Balance adjustment');
select user_id, available_cents from public.wallets where user_id in ('$A','$C') and account='options' order by user_id;
SQL
    job aureonx-price-tick false; job aureonx-options-void false;;
t1) echo "T1 30 concurrent opens with one key: one position, one premium (49.00) and one fee (0.05) debit"; snap BTC-USDT 50000.00 50000.10 1
    K=$(key 1)
    for i in $(seq 1 30); do (user $A "select public.open_option('BTC-USDT','rise',30,4900,'$K') id;" > $TMP/slice5.p$i.out) & done
    wait; cat $TMP/slice5.p*.out | sed -E 's/.*"id":"([^"]+)".*/id \1/; s/.*"message":"([^"]+)".*/error \1/' | sort | uniq -c; rm -f $TMP/slice5.p*.out
    run <<SQL
select (select count(*) from public.options_positions where client_request_id='$K') positions,
       (select string_agg(kind || ' ' || delta_cents, ', ' order by id) from public.ledger
         where ref_id=(select id from public.options_positions where client_request_id='$K')) bills,
       (select available_cents from public.wallets where user_id='$A' and account='options') options_cents;
SQL
    echo "T1b same key, other parameters"; user $A "select public.open_option('BTC-USDT','rise',30,5000,'$K');";;
t2) echo "T2 C has 49.00: premium 49.00 + fee 0.05 refused, nothing written"; snap BTC-USDT 50000.00 50000.10 1
    user $C "select public.open_option('BTC-USDT','rise',30,4900,gen_random_uuid());"
    run <<SQL
select (select available_cents from public.wallets where user_id='$C' and account='options') c_cents,
       (select count(*) from public.options_positions where user_id='$C') c_positions,
       (select count(*) from public.ledger where user_id='$C') c_bills;
SQL
    echo "T2b validation errors"
    user $A "select public.open_option('BTC-USDT','rise',30,4899,gen_random_uuid());" | sed 's/^/[premium 48.99] /'
    user $A "select public.open_option('BTC-USDT','rise',60,4900,gen_random_uuid());" | sed 's/^/[60 s disabled] /'
    user $A "select public.open_option('BTC-USDT','rise',45,4900,gen_random_uuid());" | sed 's/^/[45 s] /'
    user $A "select public.open_option('XRP-USDT','rise',30,4900,gen_random_uuid());" | sed 's/^/[XRP] /'
    user $A "select public.open_option('NOPE-USDT','rise',30,4900,gen_random_uuid());" | sed 's/^/[NOPE] /'
    user $A "select public.open_option('BTC-USDT','rise',30,4900,null);" | sed 's/^/[no key] /';;
t3) echo "T3 entry age: 16 s refused, 14 s accepted, a future snapshot refused"
    snap BTC-USDT 50000.00 50000.10 16; user $A "select public.open_option('BTC-USDT','rise',30,4900,gen_random_uuid());"
    snap BTC-USDT 50000.00 50000.10 14; user $A "select public.open_option('BTC-USDT','rise',30,4900,'$(key 3)') ok;"
    snap BTC-USDT 50000.00 50000.10 -3; user $A "select public.open_option('BTC-USDT','rise',30,4900,gen_random_uuid());"
    snap BTC-USDT 50000.00 50000.10 1;;
t4) echo "T4 659000 cents at 600 bps: fee 659 (pnl -659); win pays 659000 + 39540 (pnl sum 38881); loss 0 (pnl sum -659659); draw refunds 659000 (pnl sum -659)"
    snap BTC-USDT 50000.00 50000.10 1; snap ETH-USDT 2000.00 2000.10 1
    user $A "select public.open_option('BTC-USDT','rise',30,659000,'$(key 41)') win, public.open_option('BTC-USDT','fall',30,659000,'$(key 42)') loss, public.open_option('ETH-USDT','fall',30,659000,'$(key 43)') draw;"
    shift 40 "client_request_id in ('$(key 41)','$(key 42)','$(key 43)')"
    ingest BTC-USDT 50001.00 50001.10 0; ingest ETH-USDT 2000.00 2000.10 0
    show "'$(key 41)','$(key 42)','$(key 43)'";;
t5) echo "T5 window: a snapshot before expiry and one more than 60 s after expiry settle nothing"
    snap BTC-USDT 50000.00 50000.10 1
    user $A "select public.open_option('BTC-USDT','rise',30,4900,'$(key 51)') not_expired, public.open_option('BTC-USDT','rise',30,4900,'$(key 52)') late;"
    shift 100 "client_request_id = '$(key 52)'"
    ingest BTC-USDT 50001.00 50001.10 0
    show "'$(key 51)','$(key 52)'"
    echo "T5b the late one passes expiry + 90 s: the void job refunds premium + fee (refund pnl +5, pnl sum 0)"
    shift 25 "client_request_id = '$(key 52)'"
    echo "select private.void_stale_options() voided;" | run
    show "'$(key 51)','$(key 52)'";;
t6) echo "T6 race: ingest settle vs 3 void calls on the same due positions, 5 rounds of 20"
    for r in 1 2 3 4 5; do
      snap BTC-USDT 50000.00 50000.10 1 > /dev/null
      user $A "select count(public.open_option('BTC-USDT','rise',30,$((4910 + r)),gen_random_uuid())) opened from generate_series(1,20);" > /dev/null
      shift 125 "premium_cents = $((4910 + r))" > /dev/null
      snap BTC-USDT 50000.00 50000.10 120 > /dev/null
      ingest BTC-USDT 50002.00 50002.10 45 > $TMP/slice5.r$r.i.out &
      for v in 1 2 3; do (echo "select private.void_stale_options() voided;" | run > $TMP/slice5.r$r.v$v.out) & done
      wait
      echo "round $r: $(cat $TMP/slice5.r$r.*.out | tr -d '\n')"
    done; rm -f $TMP/slice5.r*.out
    run <<SQL
with p as (
  select p.id, p.status, p.payout_cents,
         (select count(*) from public.ledger l where l.ref_id = p.id and l.kind in ('option_settle','option_refund')) credits,
         (select coalesce(sum(l.delta_cents), 0) from public.ledger l where l.ref_id = p.id and l.kind in ('option_settle','option_refund')) credited
  from public.options_positions p where p.user_id = '$A' and p.premium_cents between 4911 and 4915)
select status, count(*) positions, min(credits) min_credits, max(credits) max_credits,
       count(*) filter (where credited <> payout_cents) wrong_amount
from p group by status order by status;
SQL
;;
t7) echo "T7 Bills: every balance change has a row; wallets reconcile with the ledger"; run <<SQL
select w.user_id = '$A' is_a, w.available_cents wallet,
       (select coalesce(sum(delta_cents), 0) from public.ledger l where l.wallet_id = w.id) ledger_sum,
       (select count(*) from public.ledger l where l.wallet_id = w.id and l.balance_after_cents < 0) negatives
from public.wallets w where w.user_id in ('$A','$C') and w.account = 'options' order by 1 desc;
SQL
    run <<SQL
select p.status, count(*) positions,
       count(*) filter (where (select count(*) from public.ledger l where l.ref_id = p.id and l.kind = 'option_premium' and l.delta_cents = -p.premium_cents) <> 1) bad_premium,
       count(*) filter (where (select count(*) from public.ledger l where l.ref_id = p.id and l.kind = 'fee' and l.delta_cents = -p.fee_cents) <> 1) bad_fee,
       count(*) filter (where (select count(*) from public.ledger l where l.ref_id = p.id and l.kind in ('option_settle','option_refund'))
                              <> case when p.status = 'open' then 0 else 1 end) bad_close,
       count(*) filter (where p.status <> 'open' and (select sum(l.pnl_cents) from public.ledger l where l.ref_id = p.id)
                              <> p.payout_cents - p.premium_cents - p.fee_cents) bad_pnl
from public.options_positions p where p.user_id = '$A' group by p.status order by p.status;
SQL
;;
t8) echo "T8 RLS and grants"
    as $B aal1 user "select (select count(*) from public.options_positions) b_sees, (select count(*) from public.option_periods) periods;"
    user $A "select count(*) a_sees from public.options_positions;"
    run <<SQL
begin; set local role anon; select count(*) from public.options_positions; commit;
SQL
    run <<SQL
begin; set local role anon; select public.server_time(); commit;
SQL
    user $A "select public.server_time() between now() - interval '1 second' and now() + interval '1 second' server_time_ok;"
    user $A "insert into public.options_positions (user_id, market_id, direction, duration_s, premium_cents, fee_cents, profit_rate_bps, entry_price, entry_price_at, created_at, expires_at, client_request_id) values ('$A','BTC-USDT','rise',30,4900,5,600,1,now(),now(),now()+interval '30 seconds',gen_random_uuid());"
    user $A "update public.options_positions set status = 'void' where user_id = '$A';"
    user $A "update public.option_periods set profit_rate_bps = 90000;"
    user $A "select private.settle_options('BTC-USDT', 1, now());"
    user $A "select private.void_stale_options();"
    user $A "select public.ingest_prices('[]'::jsonb);"
    echo "T8b open_option has no price parameter"; run <<SQL
select p.oid::regprocedure signature from pg_proc p where p.proname = 'open_option';
SQL
;;
t9) echo "T9 admin_set_option_period"
    as $B aal2 admin "select duration_s, profit_rate_bps, fee_bps, min_premium_cents, enabled from public.admin_set_option_period(60, 700, 10, 4900, true);"
    as $B aal2 admin "select duration_s, profit_rate_bps, enabled from public.admin_set_option_period(60, 0, 10, 4900, false);"
    as $B aal1 admin "select public.admin_set_option_period(60, 700, 10, 4900, true);" | sed 's/^/[aal1] /'
    as $A aal2 user "select public.admin_set_option_period(60, 700, 10, 4900, true);" | sed 's/^/[user] /'
    as $A aal2 admin "select public.admin_set_option_period(60, 700, 10, 4900, true);" | sed 's/^/[forged claim] /'
    as $B aal2 admin "select public.admin_set_option_period(60, 0, 10, 4900, true);" | sed 's/^/[enabled at 0 bps] /'
    as $B aal2 admin "select public.admin_set_option_period(45, 700, 10, 4900, true);" | sed 's/^/[45 s] /'
    run <<SQL
select (select count(*) from public.admin_audit_log where admin_id = '$B' and action = 'set_option_period') audit_rows,
       (select json_agg(json_build_array(duration_s, profit_rate_bps, enabled) order by duration_s) from public.option_periods) periods;
SQL
;;
t10) echo "T10 cron: the void job refunds a position past expiry + 90 s on its own"
    snap BTC-USDT 50000.00 50000.10 1
    user $A "select public.open_option('BTC-USDT','rise',30,4900,'$(key 10)') ok;"
    shift 125 "client_request_id = '$(key 10)'"
    job aureonx-options-void true; sleep 15
    show "'$(key 10)'"
    echo "T10b price_tick posts while a position is open, with the demand window closed"
    snap BTC-USDT 50000.00 50000.10 1
    user $A "select public.open_option('BTC-USDT','rise',30,4900,'$(key 11)') ok;"
    echo "update public.system_state set price_demand_until = '-infinity' where id; select price_demand_until from public.system_state;" | run
    echo "select (select coalesce(max(id), 0) from net._http_response) last_response_before;" | run
    echo "select private.price_tick();" | run
    sleep 5
    echo "select id, status_code, left(content, 120) body from net._http_response order by id desc limit 1;" | run;;
t11) echo "T11 a failing settlement never blocks prices: settle_options replaced by a stub that raises for BTC (rolled back)"; run <<SQL
begin;
alter function private.settle_options(text, numeric, timestamptz) rename to settle_options_real;
create function private.settle_options(p_market_id text, p_price numeric, p_fetched_at timestamptz)
returns integer language plpgsql set search_path = '' as \$f\$
begin
  if p_market_id = 'BTC-USDT' then raise exception 'stub failure'; end if;
  return private.settle_options_real(p_market_id, p_price, p_fetched_at);
end \$f\$;
insert into public.price_snapshots (market_id, bid, ask, fetched_at, source)
values ('BTC-USDT', 50000.00, 50000.10, now() - interval '1 second', 'vision'),
       ('ETH-USDT', 2000.00, 2000.10, now() - interval '1 second', 'vision')
on conflict (market_id) do update set bid = excluded.bid, ask = excluded.ask, fetched_at = excluded.fetched_at,
  source = excluded.source, ingested_at = now();
select set_config('request.jwt.claims', json_build_object('sub','$A','role','authenticated')::text, true);
create temp table k on commit drop as
  select 'BTC-USDT' m, public.open_option('BTC-USDT','rise',30,4900,gen_random_uuid()) id
  union all select 'ETH-USDT', public.open_option('ETH-USDT','rise',30,4900,gen_random_uuid());
update public.options_positions set created_at = created_at - interval '40 seconds',
  expires_at = expires_at - interval '40 seconds', entry_price_at = entry_price_at - interval '40 seconds'
where id in (select id from k);
create temp table r on commit drop as
  select public.ingest_prices(jsonb_build_array(
    jsonb_build_object('market_id','BTC-USDT','bid','50001.00','ask','50001.10','source','vision','ts', now()),
    jsonb_build_object('market_id','ETH-USDT','bid','2001.00','ask','2001.10','source','vision','ts', now()))) v;
select r.v ingest,
       (select bid::text = '50001.000000000000000000' and fetched_at = now() from public.price_snapshots where market_id = 'BTC-USDT') btc_snapshot_written,
       (select json_object_agg(k.m, p.status) from k join public.options_positions p on p.id = k.id) positions
from r;
rollback;
SQL
    echo "select count(*) stub_gone from pg_proc where proname = 'settle_options_real';" | run;;
cleanup) job aureonx-price-tick true; job aureonx-options-void true; run <<SQL
delete from public.admin_audit_log where admin_id in ('$A','$B','$C');
delete from auth.users where id in ('$A','$B','$C');
delete from public.price_snapshots where market_id in ('BTC-USDT','ETH-USDT','SOL-USDT');
update public.system_state set price_demand_until = '-infinity' where id;
select (select count(*) from public.profiles where id in ('$A','$B','$C')) profiles,
       (select count(*) from public.options_positions) positions,
       (select count(*) from public.ledger where user_id in ('$A','$B','$C')) bills,
       (select json_agg(json_build_array(duration_s, profit_rate_bps, enabled) order by duration_s) from public.option_periods) periods;
SQL
;;
*) echo "unknown step $1"; exit 1;;
esac
}

set -E
restored=0
restore() {
  [ "$restored" = 1 ] && return 0
  restored=1; trap - EXIT INT TERM ERR
  echo "== cleanup (restores both cron jobs)"; step cleanup
}
trap restore EXIT
trap 'restore; exit 130' INT
trap 'restore; exit 143' TERM
trap 'restore; exit 1' ERR

steps=("$@"); [ ${#steps[@]} -eq 0 ] && steps=(t1 t2 t3 t4 t5 t6 t7 t8 t9 t10 t11)
step setup
for s in "${steps[@]}"; do step "$s"; echo; done
