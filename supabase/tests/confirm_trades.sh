#!/bin/bash
# confirm_trades preference tests (profiles.confirm_trades, set_confirm_trades). Prints PASS/FAIL
# lines and exits non-zero if any check fails.
# Usage: supabase/tests/confirm_trades.sh  (Management API, write token required)
# One request that ends by raising its results, so it rolls back and commits nothing: its two
# test users are inserted as postgres inside it. When the column does not exist yet the
# migration file is applied inside the same request (and rolled back with it), so the script
# runs before and after the migration is applied live.
# The project comes from SUPABASE_PROJECT_REF; abort before any query unless it matches the
# ref in NEXT_PUBLIC_SUPABASE_URL.
REF=${SUPABASE_PROJECT_REF:?SUPABASE_PROJECT_REF is not set}
URL_REF=$(printf '%s' "${NEXT_PUBLIC_SUPABASE_URL:-}" | sed -nE 's#^https://([a-z0-9]+)\.supabase\.co/?$#\1#p')
if [ "$REF" != "$URL_REF" ]; then echo "SUPABASE_PROJECT_REF does not match NEXT_PUBLIC_SUPABASE_URL; aborting." >&2; exit 1; fi
DIR=$(cd "$(dirname "$0")/../migrations" && pwd)
MIGRATION="$DIR/20261031200000_confirm_trades_pref.sql"
A=aaaaaaaa-0000-4000-8000-0000000000ca
B=bbbbbbbb-0000-4000-8000-0000000000cb
run() { jq -Rs '{query: ., read_only: false}' | curl -sS -X POST "https://api.supabase.com/v1/projects/$REF/database/query" -H 'Content-Type: application/json' --data-binary @-; echo; }

HAS=$(run <<'SQL'
select count(*) as n from information_schema.columns
where table_schema = 'public' and table_name = 'profiles' and column_name = 'confirm_trades';
SQL
)
if printf '%s' "$HAS" | grep -q '"n":0'; then PRE=$(cat "$MIGRATION"); echo "column missing: applying the migration inside the rolled-back request"; else PRE=""; fi

OUT=$(run <<SQL
begin;
$PRE
create function pg_temp.as_role(p_role text, p_uid uuid, p_sql text) returns text language plpgsql as \$f\$
declare v text;
begin
  perform set_config('request.jwt.claims', coalesce(json_build_object('sub', p_uid, 'role', p_role, 'aal', 'aal1', 'user_role', 'user')::text, ''), true);
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
select '00000000-0000-0000-0000-000000000000', v.id, 'authenticated', 'authenticated', 'confirm-test-' || v.n || '@aureonx.invalid', '', now(), '{}', '{}', now(), now()
from (values ('$A'::uuid, 'a'), ('$B'::uuid, 'b')) v(id, n);
do \$t\$
declare r text := '';
begin
  r := r || 't1_default=' || pg_temp.as_role('authenticated', '$A', 'select confirm_trades::text from public.profiles where id = ''$A''') || ';';
  r := r || 't2_set_false=' || pg_temp.as_role('authenticated', '$A', 'select public.set_confirm_trades(false)::text') || ';';
  r := r || 't2_row=' || (select confirm_trades::text from public.profiles where id = '$A') || ';';
  r := r || 't3_other_untouched=' || (select confirm_trades::text from public.profiles where id = '$B') || ';';
  r := r || 't4_set_true=' || pg_temp.as_role('authenticated', '$A', 'select public.set_confirm_trades(true)::text') || ';';
  r := r || 't5_null=' || pg_temp.as_role('authenticated', '$A', 'select public.set_confirm_trades(null)::text') || ';';
  r := r || 't6_no_sub=' || pg_temp.as_role('authenticated', null, 'select public.set_confirm_trades(false)::text') || ';';
  r := r || 't7_anon=' || pg_temp.as_role('anon', null, 'select public.set_confirm_trades(false)::text') || ';';
  r := r || 't8_direct_update=' || pg_temp.as_role('authenticated', '$A', 'update public.profiles set confirm_trades = false where id = ''$A''') || ';';
  r := r || 't9_read_other=' || pg_temp.as_role('authenticated', '$A', 'select count(*)::text from public.profiles where id = ''$B''') || ';';
  raise exception 'RESULTS %', r;
end \$t\$;
SQL
)

FAILS=0
expect() { if printf '%s' "$OUT" | grep -Eq "$2"; then echo "PASS $1"; else echo "FAIL $1 (expected /$2/)"; FAILS=$((FAILS+1)); fi; }
expect "t1 a new account defaults to on" 't1_default=true;'
expect "t2 set_confirm_trades(false) returns false" 't2_set_false=false;'
expect "t2 the own row is now off" 't2_row=false;'
expect "t3 another account is untouched" 't3_other_untouched=true;'
expect "t4 set_confirm_trades(true) returns true" 't4_set_true=true;'
expect "t5 null is INVALID_ARGUMENT" 't5_null=ERR INVALID_ARGUMENT;'
expect "t6 no sub is UNAUTHENTICATED" 't6_no_sub=ERR UNAUTHENTICATED;'
expect "t7 anon cannot execute" 't7_anon=ERR permission denied for function set_confirm_trades;'
expect "t8 no direct column write" 't8_direct_update=ERR permission denied for table profiles;'
expect "t9 another account's row is not readable" 't9_read_other=0;'
if printf '%s' "$OUT" | grep -q 'RESULTS'; then :; else echo "unexpected output: $OUT"; FAILS=$((FAILS+1)); fi
echo "failures: $FAILS"
exit $((FAILS > 0))
