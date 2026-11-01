#!/bin/bash
# admin_delete_user tests (public.admin_delete_user). Prints PASS/FAIL lines and exits non-zero
# if any check fails.
# Usage: supabase/tests/admin_delete_user.sh  (Management API, write token required)
# One request that ends by raising its results, so it rolls back and commits nothing: its test
# users, the admin row and the deletions all happen inside it. When the function does not exist
# yet the migration file is applied inside the same request (and rolled back with it), so the
# script runs before and after the migration is applied live.
# The project comes from SUPABASE_PROJECT_REF; abort before any query unless it matches the
# ref in NEXT_PUBLIC_SUPABASE_URL.
REF=${SUPABASE_PROJECT_REF:?SUPABASE_PROJECT_REF is not set}
URL_REF=$(printf '%s' "${NEXT_PUBLIC_SUPABASE_URL:-}" | sed -nE 's#^https://([a-z0-9]+)\.supabase\.co/?$#\1#p')
if [ "$REF" != "$URL_REF" ]; then echo "SUPABASE_PROJECT_REF does not match NEXT_PUBLIC_SUPABASE_URL; aborting." >&2; exit 1; fi
DIR=$(cd "$(dirname "$0")/../migrations" && pwd)
MIGRATION="$DIR/20261101110000_admin_delete_user.sql"
A=aaaaaaaa-0000-4000-8000-0000000000e1   # the account that gets deleted (has a ledger row)
B=bbbbbbbb-0000-4000-8000-0000000000e2   # admin
C=cccccccc-0000-4000-8000-0000000000e3   # plain user, never an admin, never deleted
D=dddddddd-0000-4000-8000-0000000000e4   # a second admin (cannot be deleted)
K0=11111111-0000-4000-8000-0000000000e0
K1=11111111-0000-4000-8000-0000000000e1
K2=11111111-0000-4000-8000-0000000000e2
K3=11111111-0000-4000-8000-0000000000e3
K4=11111111-0000-4000-8000-0000000000e4
K5=11111111-0000-4000-8000-0000000000e5
K6=11111111-0000-4000-8000-0000000000e6
K7=11111111-0000-4000-8000-0000000000e7
run() { jq -Rs '{query: ., read_only: false}' | curl -sS -X POST "https://api.supabase.com/v1/projects/$REF/database/query" -H 'Content-Type: application/json' --data-binary @-; echo; }

HAS=$(run <<'SQL'
select count(*) as n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
where s.nspname = 'public' and p.proname = 'admin_delete_user';
SQL
)
if printf '%s' "$HAS" | grep -q '"n":0'; then PRE=$(cat "$MIGRATION"); echo "function missing: applying the migration inside the rolled-back request"; else PRE=""; fi

OUT=$(run <<SQL
begin;
$PRE
create function pg_temp.as_role(p_role text, p_uid uuid, p_user_role text, p_sql text) returns text language plpgsql as \$f\$
declare v text;
begin
  perform set_config('request.jwt.claims', coalesce(json_build_object('sub', p_uid, 'role', p_role, 'aal', 'aal1', 'user_role', p_user_role)::text, ''), true);
  execute format('set local role %I', p_role);
  begin
    execute p_sql into v;
    v := coalesce(v, 'ok');
  exception when others then
    v := 'ERR ' || sqlerrm;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  return v;
end \$f\$;
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', v.id, 'authenticated', 'authenticated', 'delete-test-' || v.n || '@aureonx.invalid', '', now(), '{}', '{}', now(), now()
from (values ('$A'::uuid, 'a'), ('$B'::uuid, 'b'), ('$C'::uuid, 'c'), ('$D'::uuid, 'd')) v(id, n);
insert into public.user_roles (user_id, role) values ('$B', 'admin'), ('$D', 'admin');
do \$t\$
declare r text := '';
begin
  -- A has a ledger row, a favorite and a support ticket before the delete.
  r := r || 't0_credit=' || pg_temp.as_role('authenticated', '$B', 'admin', 'select (public.admin_adjust_balance(''$A'', ''capital'', 5000, ''$K0'')).action') || ';';
  insert into public.user_favorites (user_id, market_id) select '$A', id from public.markets limit 1;
  r := r || 't0_before=' || (select count(*) from public.wallets where user_id = '$A') || '/' || (select count(*) from public.ledger where user_id = '$A') || '/' || (select count(*) from public.user_favorites where user_id = '$A') || ';';

  r := r || 't1_plain_user=' || pg_temp.as_role('authenticated', '$C', 'user', 'select (public.admin_delete_user(''$A'', ''$K1'')).action') || ';';
  r := r || 't2_claim_without_row=' || pg_temp.as_role('authenticated', '$C', 'admin', 'select (public.admin_delete_user(''$A'', ''$K1'')).action') || ';';
  r := r || 't3_self=' || pg_temp.as_role('authenticated', '$B', 'admin', 'select (public.admin_delete_user(''$B'', ''$K2'')).action') || ';';
  r := r || 't4_other_admin=' || pg_temp.as_role('authenticated', '$B', 'admin', 'select (public.admin_delete_user(''$D'', ''$K3'')).action') || ';';
  r := r || 't5_unknown=' || pg_temp.as_role('authenticated', '$B', 'admin', 'select (public.admin_delete_user(gen_random_uuid(), ''$K4'')).action') || ';';
  r := r || 't5_null=' || pg_temp.as_role('authenticated', '$B', 'admin', 'select (public.admin_delete_user(null, ''$K4'')).action') || ';';
  r := r || 't6_nothing_changed=' || (select count(*) from public.profiles where id in ('$A', '$B', '$D')) || '/' || (select count(*) from public.admin_audit_log where action = 'delete_user') || ';';
  r := r || 't7_no_sub=' || pg_temp.as_role('authenticated', null, 'admin', 'select (public.admin_delete_user(''$A'', ''$K5'')).action') || ';';
  r := r || 't7_anon=' || pg_temp.as_role('anon', null, 'user', 'select (public.admin_delete_user(''$A'', ''$K5'')).action') || ';';

  r := r || 't8_delete=' || pg_temp.as_role('authenticated', '$B', 'admin', 'select (public.admin_delete_user(''$A'', ''$K6'')).action') || ';';
  r := r || 't8_auth_profile=' || (select count(*) from auth.users where id = '$A') || '/' || (select count(*) from public.profiles where id = '$A') || ';';
  r := r || 't8_after=' || (select count(*) from public.wallets where user_id = '$A') || '/' || (select count(*) from public.ledger where user_id = '$A') || '/' || (select count(*) from public.user_favorites where user_id = '$A') || ';';
  r := r || 't8_others_remain=' || (select count(*) from public.profiles where id in ('$B', '$C', '$D')) || ';';
  r := r || 't9_audit=' || (select count(*) || '/' || count(*) filter (where target_user_id is null) || '/' || bool_and(admin_id = '$B') || '/' || bool_and(payload ->> 'user_id' = '$A' and payload ->> 'email' = 'delete-test-a@aureonx.invalid' and payload ->> 'uid' is not null) from public.admin_audit_log where action = 'delete_user') || ';';
  r := r || 't10_replay=' || pg_temp.as_role('authenticated', '$B', 'admin', 'select (public.admin_delete_user(''$A'', ''$K6'')).action') || ';';
  r := r || 't10_audit_rows=' || (select count(*) from public.admin_audit_log where client_request_id = '$K6') || ';';
  r := r || 't11_key_reuse=' || pg_temp.as_role('authenticated', '$B', 'admin', 'select (public.admin_delete_user(''$C'', ''$K6'')).action') || ';';
  r := r || 't11_again_new_key=' || pg_temp.as_role('authenticated', '$B', 'admin', 'select (public.admin_delete_user(''$A'', ''$K7'')).action') || ';';
  raise exception 'RESULTS %', r;
end \$t\$;
SQL
)

FAILS=0
expect() { if printf '%s' "$OUT" | grep -Eq "$2"; then echo "PASS $1"; else echo "FAIL $1 (expected /$2/)"; FAILS=$((FAILS+1)); fi; }
expect "t0 the target has wallets, a ledger row and a favorite" 't0_before=4/1/1;'
expect "t1 a plain user is FORBIDDEN" 't1_plain_user=ERR FORBIDDEN;'
expect "t2 an admin claim without the live row is FORBIDDEN" 't2_claim_without_row=ERR FORBIDDEN;'
expect "t3 an admin cannot delete themselves" 't3_self=ERR CANNOT_DELETE_SELF;'
expect "t4 an admin account is ADMIN_PROTECTED" 't4_other_admin=ERR ADMIN_PROTECTED;'
expect "t5 an unknown user is INVALID_ARGUMENT" 't5_unknown=ERR INVALID_ARGUMENT;'
expect "t5 a null user is INVALID_ARGUMENT" 't5_null=ERR INVALID_ARGUMENT;'
expect "t6 refused calls deleted nothing and wrote no audit row" 't6_nothing_changed=3/0;'
expect "t7 no sub is UNAUTHENTICATED" 't7_no_sub=ERR UNAUTHENTICATED;'
expect "t7 anon cannot execute" 't7_anon=ERR permission denied for function admin_delete_user;'
expect "t8 an admin deletes the account and gets the audit action" 't8_delete=delete_user;'
expect "t8 the auth user and profile are gone" 't8_auth_profile=0/0;'
expect "t8 wallets, ledger and favorites are gone" 't8_after=0/0/0;'
expect "t8 every other account remains" 't8_others_remain=3;'
expect "t9 one audit row, target null, payload keeps the user" 't9_audit=1/1/true/true;'
expect "t10 a replay after the deletion returns the same action" 't10_replay=delete_user;'
expect "t10 a replay writes no second audit row" 't10_audit_rows=1;'
expect "t11 a key reused for another user is IDEMPOTENCY_CONFLICT" 't11_key_reuse=ERR IDEMPOTENCY_CONFLICT;'
expect "t11 deleting the same user again is INVALID_ARGUMENT" 't11_again_new_key=ERR INVALID_ARGUMENT;'
if printf '%s' "$OUT" | grep -q 'RESULTS'; then :; else echo "unexpected output: $OUT"; FAILS=$((FAILS+1)); fi
echo "failures: $FAILS"
exit $((FAILS > 0))
