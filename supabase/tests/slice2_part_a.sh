#!/bin/bash
# Part A tests. Prints only query results / error messages (no tokens).
# Usage: supabase/tests/slice2_part_a.sh setup|t1|...|t8|cleanup  (Management API, write token required)
REF=bpntonctvsccrrgstemi
A=aaaaaaaa-0000-4000-8000-00000000000a   # plain user
B=bbbbbbbb-0000-4000-8000-00000000000b   # admin
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
bal() { run <<SQL
select w.account, w.available_cents, (select count(*) from public.ledger l where l.wallet_id=w.id) ledger_rows
from public.wallets w where w.user_id='$1' order by account;
SQL
}
case "$1" in
setup) run <<SQL
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000','$A','authenticated','authenticated','slice2-test-a@aureonx.invalid','',now(),'{}','{"nickname":"TestA"}',now(),now()),
       ('00000000-0000-0000-0000-000000000000','$B','authenticated','authenticated','slice2-test-b@aureonx.invalid','',now(),'{}','{"nickname":"TestB"}',now(),now());
insert into public.user_roles (user_id, role) values ('$B','admin');
select count(*) wallets from public.wallets where user_id in ('$A','$B');
SQL
;;
t1) echo "T1 admin aal2 credits A spot 100.00"; as $B aal2 admin "select (public.admin_adjust_balance('$A','spot',10000,'slice 2 test credit',gen_random_uuid())).action;"; bal $A;;
t2) echo "T2 non-admin calls admin RPC"; as $A aal2 user "select public.admin_adjust_balance('$A','spot',10000,'self credit',gen_random_uuid());"
    echo "T2b non-admin with a forged admin claim"; as $A aal2 admin "select public.admin_adjust_balance('$A','spot',10000,'self credit',gen_random_uuid());";;
t3) echo "T3 admin at aal1"; as $B aal1 admin "select public.admin_adjust_balance('$A','spot',10000,'aal1 credit',gen_random_uuid());"; bal $A;;
t4) echo "T4 transfer more than balance"; as $A aal1 user "select public.transfer_between_wallets('spot','options',10001,gen_random_uuid());"
    echo "T4b same wallet"; as $A aal1 user "select public.transfer_between_wallets('spot','spot',100,gen_random_uuid());"; bal $A;;
t5) echo "T5 20 parallel transfers of 10.00 from spot (100.00) plus 10 opposite-direction transfers"
    for i in $(seq 1 20); do (as $A aal1 user "select (public.transfer_between_wallets('spot','options',1000,gen_random_uuid())).amount_cents ok;" > ${TMPDIR:-/tmp}/slice2.p$i.out) & done
    for i in $(seq 21 30); do (as $A aal1 user "select (public.transfer_between_wallets('options','spot',500,gen_random_uuid())).amount_cents ok;" > ${TMPDIR:-/tmp}/slice2.p$i.out) & done
    wait; cat ${TMPDIR:-/tmp}/slice2.p*.out | sed -E 's/.*"ok":([0-9]+).*/ok \1/; s/.*(INSUFFICIENT_FUNDS|deadlock[^"]*).*/fail \1/' | sort | uniq -c; rm -f ${TMPDIR:-/tmp}/slice2.p*.out
    bal $A
    run <<SQL
select (select sum(delta_cents) from public.ledger where user_id='$A') ledger_sum,
       (select sum(available_cents) from public.wallets where user_id='$A') wallet_sum,
       (select count(*) from public.transfers where user_id='$A') transfers,
       (select count(*) from public.ledger where user_id='$A' and ref_type='transfer') transfer_rows,
       (select count(*) from public.ledger where user_id='$A' and balance_after_cents<0) negatives;
SQL
;;
t6) echo "T6 idempotent replay"; K=11111111-0000-4000-8000-000000000001
    as $A aal1 user "select (public.transfer_between_wallets('options','capital',100,'$K')).id;"
    as $A aal1 user "select (public.transfer_between_wallets('options','capital',100,'$K')).id;"
    as $A aal1 user "select public.transfer_between_wallets('options','capital',999,'$K');"
    echo "T6b Bills rows for that transfer"
    run <<SQL
select account, kind, counter_account, delta_cents, balance_after_cents from public.ledger
where ref_id=(select id from public.transfers where client_request_id='$K') order by id;
SQL
;;
t7) echo "T7 RLS as A"; as $A aal2 user "select (select count(*) from public.wallets) wallets, (select count(*) from public.ledger where user_id<>'$A') others_ledger, (select count(*) from public.profiles) profiles;"
    as $A aal2 user "select count(*) from public.transfers;"
    as $A aal2 user "select count(*) from public.admin_audit_log;"
    as $A aal2 user "update public.wallets set available_cents=999999 where user_id='$A';"
    as $A aal2 user "select private.wallet_apply(gen_random_uuid(),1,0,'admin_credit','admin_adjustment',gen_random_uuid());"
    echo "T7b admin B at aal1 vs aal2"
    as $B aal1 admin "select (select count(*) from public.profiles) profiles, (select count(*) from public.wallets) wallets;"
    as $B aal2 admin "select (select count(*) from public.profiles) profiles, (select count(*) from public.wallets) wallets;"
    echo "T7c anon"; run <<SQL
begin; set local role anon; select (select count(*) from public.wallets) w, (select count(*) from public.ledger) l, (select count(*) from public.profiles) p; commit;
SQL
;;
t8) echo "T8 admin debit beyond balance, then a valid debit"
    as $B aal2 admin "select public.admin_adjust_balance('$A','capital',-999999,'too much',gen_random_uuid());"
    as $B aal2 admin "select (public.admin_adjust_balance('$A','capital',-100,'slice 2 test debit',gen_random_uuid())).action;"
    run <<SQL
select kind, delta_cents, actor_id is not null has_actor, memo from public.ledger where user_id='$A' and ref_type='admin_adjustment' order by id;
SQL
;;
cleanup) run <<SQL
delete from public.admin_audit_log where target_user_id in ('$A','$B') or admin_id in ('$A','$B');
delete from auth.users where id in ('$A','$B');
select (select count(*) from public.profiles where id in ('$A','$B')) p, (select count(*) from public.wallets where user_id in ('$A','$B')) w,
       (select count(*) from public.ledger where user_id in ('$A','$B')) l, (select count(*) from public.transfers where user_id in ('$A','$B')) t,
       (select count(*) from public.user_roles where user_id in ('$A','$B')) r;
SQL
;;
esac
