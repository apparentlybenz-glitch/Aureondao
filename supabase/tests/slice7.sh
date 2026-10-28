#!/bin/bash
# Slice 7 tests (account suspension, Audit Log read). Prints PASS/FAIL lines (no keys) and
# exits non-zero if any check fails.
# Usage: supabase/tests/slice7.sh [t1 ... t7]  (Management API, write token required)
# Always runs setup, the given steps (all by default), then cleanup, in one process.
# setup pauses the aureonx-price-tick and aureonx-options-void cron jobs so live prices never
# settle a test position and the tests call settlement themselves. A trap on EXIT, INT, TERM
# and ERR runs cleanup, which turns both jobs back on and deletes the test users and their
# audit rows. Test snapshots are written as postgres with fixed prices (BTC 50000.00 / 50000.10).
# The project comes from SUPABASE_PROJECT_REF; abort before any query unless it matches the
# ref in NEXT_PUBLIC_SUPABASE_URL.
REF=${SUPABASE_PROJECT_REF:?SUPABASE_PROJECT_REF is not set}
URL_REF=$(printf '%s' "${NEXT_PUBLIC_SUPABASE_URL:-}" | sed -nE 's#^https://([a-z0-9]+)\.supabase\.co/?$#\1#p')
if [ "$REF" != "$URL_REF" ]; then echo "SUPABASE_PROJECT_REF does not match NEXT_PUBLIC_SUPABASE_URL; aborting." >&2; exit 1; fi
A=aaaaaaaa-0000-4000-8000-00000000007a   # trader
B=bbbbbbbb-0000-4000-8000-00000000007b   # admin
C=cccccccc-0000-4000-8000-00000000007c   # plain user (never an admin)
FAILS=0
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
adm() { as $B aal2 admin "$1"; }
# expect <label> <extended regex> <output>
expect() { if printf '%s' "$3" | grep -Eq "$2"; then echo "PASS $1"; else echo "FAIL $1 (expected /$2/): $3"; FAILS=$((FAILS+1)); fi; }
key() { printf '77777777-0000-4000-8000-%012d' "$1"; }
# susp <true|false> <reason sql literal or null>: suspend or unsuspend A through the RPC as the admin at aal2.
susp() { adm "select (public.admin_set_suspension('$A', $1, $2, gen_random_uuid())).action;"; }
snap() { run <<SQL
insert into public.price_snapshots (market_id, bid, ask, fetched_at, source)
values ('$1', $2, $3, now() - interval '$4 seconds', 'vision')
on conflict (market_id) do update set bid = excluded.bid, ask = excluded.ask,
  fetched_at = excluded.fetched_at, source = excluded.source, ingested_at = now();
SQL
}
ingest() { run <<SQL
begin; set local role service_role;
select public.ingest_prices(jsonb_build_array(jsonb_build_object('market_id','$1','bid','$2','ask','$3',
  'source','vision','ts', now() - interval '$4 seconds'))) ingest;
commit;
SQL
}
job() { echo "select cron.alter_job((select jobid from cron.job where jobname = '$1'), active := $2); select jobname, active from cron.job where jobname = '$1';" | run; }
# state: balances and row counts that a refused money call must leave unchanged.
state() { echo "select (select string_agg(account || ':' || available_cents, ',' order by account) from public.wallets where user_id = '$A') wallets,
  (select count(*) from public.ledger where user_id = '$A') bills, (select count(*) from public.orders where user_id = '$A') orders,
  (select count(*) from public.options_positions where user_id = '$A') positions,
  (select count(*) from public.transfers where user_id = '$A') transfers;" | run; }
wallet() { echo "select available_cents::text c from public.wallets where user_id = '$A' and account = '$1';" | run | jq -r '.[0].c'; }

step() {
case "$1" in
setup) run <<SQL
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000','$A','authenticated','authenticated','slice7-test-a@aureonx.invalid','',now(),'{}','{"nickname":"TestA"}',now(),now()),
       ('00000000-0000-0000-0000-000000000000','$B','authenticated','authenticated','slice7-test-b@aureonx.invalid','',now(),'{}','{"nickname":"TestB"}',now(),now()),
       ('00000000-0000-0000-0000-000000000000','$C','authenticated','authenticated','slice7-test-c@aureonx.invalid','',now(),'{}','{"nickname":"TestC"}',now(),now());
insert into public.user_roles (user_id, role) values ('$B','admin');
select private.wallet_apply((select id from public.wallets where user_id='$A' and account='capital'),
  1000000, 0, 'admin_credit', 'admin_adjustment', gen_random_uuid(), p_memo => 'Balance adjustment');
select private.wallet_apply((select id from public.wallets where user_id='$A' and account='spot'),
  1000000, 0, 'admin_credit', 'admin_adjustment', gen_random_uuid(), p_memo => 'Balance adjustment');
select private.wallet_apply((select id from public.wallets where user_id='$A' and account='options'),
  3000000, 0, 'admin_credit', 'admin_adjustment', gen_random_uuid(), p_memo => 'Balance adjustment');
select user_id, account, available_cents from public.wallets where user_id = '$A' order by account;
SQL
    job aureonx-price-tick false; job aureonx-options-void false;;
t1) echo "T1 admin_set_suspension: FORBIDDEN and argument checks; nothing changes"
    K=$(key 1); LONG=$(printf 'x%.0s' $(seq 1 201))
    expect "plain user at aal2 -> FORBIDDEN" FORBIDDEN "$(as $C aal2 user "select (public.admin_set_suspension('$A', true, 'abuse review', '$K')).action;")"
    expect "plain user at aal1 -> FORBIDDEN" FORBIDDEN "$(as $C aal1 user "select (public.admin_set_suspension('$A', true, 'abuse review', '$K')).action;")"
    expect "admin claim without an admin row at aal1 -> FORBIDDEN" FORBIDDEN "$(as $C aal1 admin "select (public.admin_set_suspension('$A', true, 'abuse review', '$K')).action;")"
    expect "admin at aal1 passes the gate (unknown user -> INVALID_ARGUMENT)" INVALID_ARGUMENT "$(as $B aal1 admin "select (public.admin_set_suspension('00000000-0000-4000-8000-000000000001', true, 'abuse review', '$K')).action;")"
    expect "admin claim without an admin row -> FORBIDDEN" FORBIDDEN "$(as $C aal2 admin "select (public.admin_set_suspension('$A', true, 'abuse review', '$K')).action;")"
    expect "suspend without a reason -> NOTE_REQUIRED" NOTE_REQUIRED "$(adm "select (public.admin_set_suspension('$A', true, null, '$K')).action;")"
    expect "reason of 2 characters -> NOTE_REQUIRED" NOTE_REQUIRED "$(adm "select (public.admin_set_suspension('$A', true, 'ab', '$K')).action;")"
    expect "reason of 201 characters -> NOTE_REQUIRED" NOTE_REQUIRED "$(adm "select (public.admin_set_suspension('$A', true, '$LONG', '$K')).action;")"
    expect "unknown user -> INVALID_ARGUMENT" INVALID_ARGUMENT "$(adm "select (public.admin_set_suspension('00000000-0000-4000-8000-000000000001', true, 'abuse review', '$K')).action;")"
    expect "no key -> INVALID_ARGUMENT" INVALID_ARGUMENT "$(adm "select (public.admin_set_suspension('$A', true, 'abuse review', null)).action;")"
    expect "nothing changed" '"s":false,"a":0' "$(echo "select (suspended_at is not null) s, (select count(*) from public.admin_audit_log where admin_id in ('$B','$C')) a from public.profiles where id = '$A';" | run)";;
t2) echo "T2 suspend and unsuspend at aal2, replay, own read, no client write"
    K=$(key 2)
    expect "suspend returns the audit row" '"action":"suspend"' "$(adm "select (public.admin_set_suspension('$A', true, 'chargeback review', '$K')).action;")"
    expect "profile is suspended with the reason" '"s":true,"r":"chargeback review"' "$(echo "select (suspended_at is not null) s, suspension_reason r from public.profiles where id = '$A';" | run)"
    expect "the user reads their own state" '"s":true,"r":"chargeback review"' "$(user $A "select (suspended_at is not null) s, suspension_reason r from public.profiles where id = '$A';")"
    expect "another user cannot read it" '"count":0' "$(user $C "select count(*) from public.profiles where id = '$A';")"
    expect "no client write" 'permission denied' "$(user $A "update public.profiles set suspended_at = null, suspension_reason = null where id = '$A';")"
    adm "select (public.admin_set_suspension('$A', true, 'chargeback review', '$K')).action;" > /dev/null
    expect "same key twice: one audit row" '"n":1' "$(echo "select count(*) n from public.admin_audit_log where client_request_id = '$K';" | run)"
    expect "same key, other reason -> IDEMPOTENCY_CONFLICT" IDEMPOTENCY_CONFLICT "$(adm "select (public.admin_set_suspension('$A', true, 'other reason', '$K')).action;")"
    expect "same key, other action -> IDEMPOTENCY_CONFLICT" IDEMPOTENCY_CONFLICT "$(adm "select (public.admin_set_suspension('$A', false, null, '$K')).action;")"
    T0=$(echo "select suspended_at::text t from public.profiles where id = '$A';" | run | jq -r '.[0].t')
    susp true "'second look'" > /dev/null
    T1=$(echo "select suspended_at::text t from public.profiles where id = '$A';" | run | jq -r '.[0].t')
    [ "$T0" = "$T1" ] && expect "suspending again keeps suspended_at" . x || expect "suspending again keeps suspended_at" NEVER "$T0 vs $T1"
    expect "reason replaced" '"r":"second look"' "$(echo "select suspension_reason r from public.profiles where id = '$A';" | run)"
    expect "unsuspend needs no reason" '"action":"unsuspend"' "$(susp false null)"
    expect "both columns null again" '"s":false,"r":null' "$(echo "select (suspended_at is not null) s, suspension_reason r from public.profiles where id = '$A';" | run)";;
t3) echo "T3 suspended: spot_market_order, open_option and transfer_between_wallets each refuse and change nothing"
    susp true "'under review'" > /dev/null; snap BTC-USDT 50000.00 50000.10 1 > /dev/null
    BEFORE=$(state)
    expect "spot_market_order" ACCOUNT_SUSPENDED "$(user $A "select public.spot_market_order('BTC-USDT','buy','0.001',gen_random_uuid());")"
    expect "open_option" ACCOUNT_SUSPENDED "$(user $A "select public.open_option('BTC-USDT','rise',30,4900,gen_random_uuid());")"
    expect "transfer_between_wallets" ACCOUNT_SUSPENDED "$(user $A "select public.transfer_between_wallets('capital','spot',10000,gen_random_uuid());")"
    AFTER=$(state)
    [ "$BEFORE" = "$AFTER" ] && expect "balances and row counts unchanged" . x || expect "balances and row counts unchanged" NEVER "$BEFORE vs $AFTER";;
t4) echo "T4 an option opened before the suspension still settles and pays out (659000 win: 659000 + 39540)"
    susp false null > /dev/null; snap BTC-USDT 50000.00 50000.10 1 > /dev/null
    P=$(key 4)
    expect "option opened while active" '"id"' "$(user $A "select public.open_option('BTC-USDT','rise',30,659000,'$P') id;")"
    susp true "'suspended with an open option'" > /dev/null
    echo "update public.options_positions set created_at = created_at - interval '40 seconds', expires_at = expires_at - interval '40 seconds',
      entry_price_at = entry_price_at - interval '40 seconds' where client_request_id = '$P';" | run > /dev/null
    ingest BTC-USDT 50001.00 50001.10 0 > /dev/null
    expect "position settled as a win with the full payout" '"status":"settled","result":"win","payout_cents":698540' "$(echo "select status, result, payout_cents from public.options_positions where client_request_id = '$P';" | run)"
    expect "option_settle bill written" 'option_settle 698540' "$(echo "select string_agg(kind || ' ' || delta_cents, ', ' order by id) bills from public.ledger where ref_id = (select id from public.options_positions where client_request_id = '$P');" | run)"
    expect "the account is still suspended" '"s":true' "$(echo "select (suspended_at is not null) s from public.profiles where id = '$A';" | run)";;
t5) echo "T5 admin_adjust_balance still credits a suspended account"
    susp true "'under review'" > /dev/null
    BEFORE=$(wallet capital)
    expect "credit applied" '"action":"adjust_balance"' "$(adm "select (public.admin_adjust_balance('$A', 'capital', 500000, 'goodwill credit', '$(key 5)')).action;")"
    AFTER=$(wallet capital)
    [ $((AFTER - BEFORE)) -eq 500000 ] && expect "capital wallet up by 500000" . x || expect "capital wallet up by 500000" NEVER "$BEFORE -> $AFTER"
    expect "the account is still suspended" '"s":true' "$(echo "select (suspended_at is not null) s from public.profiles where id = '$A';" | run)";;
t6) echo "T6 after unsuspend all three money RPCs work again"
    susp false null > /dev/null; snap BTC-USDT 50000.00 50000.10 1 > /dev/null
    expect "spot_market_order" '"side":"buy"' "$(user $A "select (public.spot_market_order('BTC-USDT','buy','0.001','$(key 61)')).side;")"
    expect "open_option" '"id"' "$(user $A "select public.open_option('BTC-USDT','rise',30,4900,'$(key 62)') id;")"
    expect "transfer_between_wallets" '"amount_cents":"?10000' "$(user $A "select (public.transfer_between_wallets('capital','spot',10000,'$(key 63)')).amount_cents;")";;
t7) echo "T7 audit rows: written by every RPC call, readable by an admin (aal1 or aal2)"
    expect "actions and admin on every row" '"actions":"adjust_balance,suspend,unsuspend","wrong_admin":0,"suspend_without_reason":0' "$(adm "select string_agg(distinct action, ',' order by action) actions, count(*) filter (where admin_id is distinct from '$B') wrong_admin,
      count(*) filter (where action = 'suspend' and payload ->> 'reason' is null) suspend_without_reason from public.admin_audit_log where target_user_id = '$A';")"
    expect "a plain user reads no audit rows" '"count":0' "$(user $A "select count(*) from public.admin_audit_log;")"
    expect "an admin at aal1 reads them too" '"count":[1-9]' "$(as $B aal1 admin "select count(*) from public.admin_audit_log;")"
    expect "a plain user at aal1 reads none" '"count":0' "$(as $C aal1 user "select count(*) from public.admin_audit_log;")"
    expect "an admin at aal2 reads them" '"n":[1-9]' "$(adm "select count(*) n from public.admin_audit_log where target_user_id = '$A';")";;
cleanup) job aureonx-price-tick true; job aureonx-options-void true; run <<SQL
delete from public.admin_audit_log where admin_id in ('$A','$B','$C') or target_user_id in ('$A','$B','$C');
delete from auth.users where id in ('$A','$B','$C');
delete from public.price_snapshots where market_id = 'BTC-USDT';
update public.system_state set price_demand_until = '-infinity' where id;
select (select count(*) from public.profiles where id in ('$A','$B','$C')) profiles,
       (select count(*) from public.ledger where user_id in ('$A','$B','$C')) bills,
       (select count(*) from public.orders where user_id in ('$A','$B','$C')) orders,
       (select count(*) from public.options_positions where user_id in ('$A','$B','$C')) positions,
       (select count(*) from public.transfers where user_id in ('$A','$B','$C')) transfers,
       (select count(*) from public.spot_holdings where user_id in ('$A','$B','$C')) holdings,
       (select count(*) from public.admin_audit_log where admin_id in ('$A','$B','$C') or target_user_id in ('$A','$B','$C')) audit_rows,
       (select json_agg(json_build_array(jobname, active) order by jobname) from cron.job where jobname in ('aureonx-price-tick','aureonx-options-void')) jobs;
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

steps=("$@"); [ ${#steps[@]} -eq 0 ] && steps=(t1 t2 t3 t4 t5 t6 t7)
step setup
for s in "${steps[@]}"; do step "$s"; echo; done
echo "== $FAILS check(s) failed"
exit $FAILS
