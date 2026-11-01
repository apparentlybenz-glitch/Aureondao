#!/bin/bash
# Withdraw restriction tests (profiles.withdraw_restricted_at, admin_set_withdraw_restriction).
# Prints PASS/FAIL lines and exits non-zero if any check fails.
# Usage: supabase/tests/withdraw_restriction.sh  (Management API, write token required)
# One request that ends by raising its results, so it rolls back and commits nothing: its test
# users and the admin row are inserted as postgres inside it. When the column does not exist
# yet the migration file is applied inside the same request (and rolled back with it), so the
# script runs before and after the migration is applied live.
# The project comes from SUPABASE_PROJECT_REF; abort before any query unless it matches the
# ref in NEXT_PUBLIC_SUPABASE_URL.
REF=${SUPABASE_PROJECT_REF:?SUPABASE_PROJECT_REF is not set}
URL_REF=$(printf '%s' "${NEXT_PUBLIC_SUPABASE_URL:-}" | sed -nE 's#^https://([a-z0-9]+)\.supabase\.co/?$#\1#p')
if [ "$REF" != "$URL_REF" ]; then echo "SUPABASE_PROJECT_REF does not match NEXT_PUBLIC_SUPABASE_URL; aborting." >&2; exit 1; fi
DIR=$(cd "$(dirname "$0")/../migrations" && pwd)
MIGRATION="$DIR/20261101100000_withdraw_restriction.sql"
A=aaaaaaaa-0000-4000-8000-0000000000d1   # restricted account
B=bbbbbbbb-0000-4000-8000-0000000000d2   # admin
C=cccccccc-0000-4000-8000-0000000000d3   # plain user, never an admin
K1=11111111-0000-4000-8000-0000000000d1
K2=11111111-0000-4000-8000-0000000000d2
K3=11111111-0000-4000-8000-0000000000d3
K4=11111111-0000-4000-8000-0000000000d4
K5=11111111-0000-4000-8000-0000000000d5
run() { jq -Rs '{query: ., read_only: false}' | curl -sS -X POST "https://api.supabase.com/v1/projects/$REF/database/query" -H 'Content-Type: application/json' --data-binary @-; echo; }

HAS=$(run <<'SQL'
select count(*) as n from information_schema.columns
where table_schema = 'public' and table_name = 'profiles' and column_name = 'withdraw_restricted_at';
SQL
)
if printf '%s' "$HAS" | grep -q '"n":0'; then PRE=$(cat "$MIGRATION"); echo "column missing: applying the migration inside the rolled-back request"; else PRE=""; fi

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
select '00000000-0000-0000-0000-000000000000', v.id, 'authenticated', 'authenticated', 'withdraw-test-' || v.n || '@aureonx.invalid', '', now(), '{}', '{}', now(), now()
from (values ('$A'::uuid, 'a'), ('$B'::uuid, 'b'), ('$C'::uuid, 'c')) v(id, n);
insert into public.user_roles (user_id, role) values ('$B', 'admin');
do \$t\$
declare r text := ''; v_first timestamptz;
begin
  r := r || 't1_default=' || (select (withdraw_restricted_at is null)::text from public.profiles where id = '$A') || ';';
  r := r || 't2_restrict=' || pg_temp.as_role('authenticated', '$B', 'admin', 'select (public.admin_set_withdraw_restriction(''$A'', true, ''$K1'')).action') || ';';
  r := r || 't2_row=' || (select (withdraw_restricted_at is not null)::text from public.profiles where id = '$A') || ';';
  r := r || 't2_suspended_untouched=' || (select (suspended_at is null)::text from public.profiles where id = '$A') || ';';
  r := r || 't3_replay=' || pg_temp.as_role('authenticated', '$B', 'admin', 'select (public.admin_set_withdraw_restriction(''$A'', true, ''$K1'')).action') || ';';
  r := r || 't3_audit_rows=' || (select count(*)::text from public.admin_audit_log where client_request_id = '$K1') || ';';
  r := r || 't4_key_reuse=' || pg_temp.as_role('authenticated', '$B', 'admin', 'select (public.admin_set_withdraw_restriction(''$A'', false, ''$K1'')).action') || ';';
  r := r || 't4_other_user_reuse=' || pg_temp.as_role('authenticated', '$B', 'admin', 'select (public.admin_set_withdraw_restriction(''$C'', true, ''$K1'')).action') || ';';
  r := r || 't5_own_read=' || pg_temp.as_role('authenticated', '$A', 'user', 'select (withdraw_restricted_at is not null)::text from public.profiles where id = ''$A''') || ';';
  r := r || 't5_other_read=' || pg_temp.as_role('authenticated', '$A', 'user', 'select count(*)::text from public.profiles where id = ''$B''') || ';';
  r := r || 't6_plain_user=' || pg_temp.as_role('authenticated', '$C', 'user', 'select (public.admin_set_withdraw_restriction(''$A'', false, ''$K2'')).action') || ';';
  r := r || 't7_claim_without_row=' || pg_temp.as_role('authenticated', '$C', 'admin', 'select (public.admin_set_withdraw_restriction(''$A'', false, ''$K2'')).action') || ';';
  r := r || 't7_still_restricted=' || (select (withdraw_restricted_at is not null)::text from public.profiles where id = '$A') || ';';
  select withdraw_restricted_at into v_first from public.profiles where id = '$A';
  r := r || 't8_again=' || pg_temp.as_role('authenticated', '$B', 'admin', 'select (public.admin_set_withdraw_restriction(''$A'', true, ''$K3'')).action') || ';';
  r := r || 't8_keeps_time=' || (select (withdraw_restricted_at = v_first)::text from public.profiles where id = '$A') || ';';
  r := r || 't9_unrestrict=' || pg_temp.as_role('authenticated', '$B', 'admin', 'select (public.admin_set_withdraw_restriction(''$A'', false, ''$K4'')).action') || ';';
  r := r || 't9_row=' || (select (withdraw_restricted_at is null)::text from public.profiles where id = '$A') || ';';
  r := r || 't10_unknown_user=' || pg_temp.as_role('authenticated', '$B', 'admin', 'select (public.admin_set_withdraw_restriction(gen_random_uuid(), true, ''$K5'')).action') || ';';
  r := r || 't10_null=' || pg_temp.as_role('authenticated', '$B', 'admin', 'select (public.admin_set_withdraw_restriction(''$A'', null, ''$K5'')).action') || ';';
  r := r || 't11_no_sub=' || pg_temp.as_role('authenticated', null, 'admin', 'select (public.admin_set_withdraw_restriction(''$A'', true, ''$K5'')).action') || ';';
  r := r || 't12_anon=' || pg_temp.as_role('anon', null, 'user', 'select (public.admin_set_withdraw_restriction(''$A'', true, ''$K5'')).action') || ';';
  r := r || 't13_direct_update=' || pg_temp.as_role('authenticated', '$A', 'user', 'update public.profiles set withdraw_restricted_at = null where id = ''$A''') || ';';
  r := r || 't14_audit_actions=' || (select string_agg(action, ',' order by action) from public.admin_audit_log where target_user_id = '$A') || ';';
  r := r || 't14_payloads=' || (select count(*) filter (where payload <> '{}'::jsonb)::text from public.admin_audit_log where target_user_id = '$A') || ';';
  raise exception 'RESULTS %', r;
end \$t\$;
SQL
)

FAILS=0
expect() { if printf '%s' "$OUT" | grep -Eq "$2"; then echo "PASS $1"; else echo "FAIL $1 (expected /$2/)"; FAILS=$((FAILS+1)); fi; }
expect "t1 a new account is not restricted" 't1_default=true;'
expect "t2 an admin restricts and gets the audit action" 't2_restrict=withdraw_restrict;'
expect "t2 the flag is set" 't2_row=true;'
expect "t2 suspension is untouched" 't2_suspended_untouched=true;'
expect "t3 a replay returns the same action" 't3_replay=withdraw_restrict;'
expect "t3 a replay writes one audit row" 't3_audit_rows=1;'
expect "t4 a key reused for the other action is IDEMPOTENCY_CONFLICT" 't4_key_reuse=ERR IDEMPOTENCY_CONFLICT;'
expect "t4 a key reused for another user is IDEMPOTENCY_CONFLICT" 't4_other_user_reuse=ERR IDEMPOTENCY_CONFLICT;'
expect "t5 a user reads their own flag" 't5_own_read=true;'
expect "t5 a user cannot read another profile" 't5_other_read=0;'
expect "t6 a plain user is FORBIDDEN" 't6_plain_user=ERR FORBIDDEN;'
expect "t7 an admin claim without the live row is FORBIDDEN" 't7_claim_without_row=ERR FORBIDDEN;'
expect "t7 the refused calls changed nothing" 't7_still_restricted=true;'
expect "t8 restricting again returns the action" 't8_again=withdraw_restrict;'
expect "t8 restricting again keeps the original time" 't8_keeps_time=true;'
expect "t9 an admin unrestricts" 't9_unrestrict=withdraw_unrestrict;'
expect "t9 the flag is cleared" 't9_row=true;'
expect "t10 an unknown user is INVALID_ARGUMENT" 't10_unknown_user=ERR INVALID_ARGUMENT;'
expect "t10 a null flag is INVALID_ARGUMENT" 't10_null=ERR INVALID_ARGUMENT;'
expect "t11 no sub is UNAUTHENTICATED" 't11_no_sub=ERR UNAUTHENTICATED;'
expect "t12 anon cannot execute" 't12_anon=ERR permission denied for function admin_set_withdraw_restriction;'
expect "t13 no direct column write" 't13_direct_update=ERR permission denied for table profiles;'
expect "t14 one audit row per non-replay call" 't14_audit_actions=withdraw_restrict,withdraw_restrict,withdraw_unrestrict;'
expect "t14 payloads are empty" 't14_payloads=0;'
if printf '%s' "$OUT" | grep -q 'RESULTS'; then :; else echo "unexpected output: $OUT"; FAILS=$((FAILS+1)); fi
echo "failures: $FAILS"
exit $((FAILS > 0))
