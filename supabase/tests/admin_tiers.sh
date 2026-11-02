#!/bin/bash
# Admin tier tests (20261102120000_admin_head_only.sql): admin_adjust_balance, admin_set_option_period,
# admin_set_fx_period, admin_delete_user and admin_audit_log reads are head admin only; the RPCs an
# ordinary admin keeps still work for one. Prints PASS/FAIL lines and exits non-zero if any check fails.
# Usage: supabase/tests/admin_tiers.sh  (Management API, write token required; DEBUG=1 also prints every result)
# One request that ends by raising its results, so it rolls back and commits nothing: its test users
# and their user_roles rows (an ordinary admin, a head admin, an owner) are inserted as postgres inside
# it. When the migration is not applied yet it is applied inside the same request (and rolled back with
# it), so the script runs before and after the live apply. The last checks run the migration's own
# rollback comment inside the request and show an ordinary admin regains the four RPCs.
# The project comes from SUPABASE_PROJECT_REF; abort before any query unless it matches the
# ref in NEXT_PUBLIC_SUPABASE_URL.
REF=${SUPABASE_PROJECT_REF:?SUPABASE_PROJECT_REF is not set}
URL_REF=$(printf '%s' "${NEXT_PUBLIC_SUPABASE_URL:-}" | sed -nE 's#^https://([a-z0-9]+)\.supabase\.co/?$#\1#p')
if [ "$REF" != "$URL_REF" ]; then echo "SUPABASE_PROJECT_REF does not match NEXT_PUBLIC_SUPABASE_URL; aborting." >&2; exit 1; fi
DIR=$(cd "$(dirname "$0")/../migrations" && pwd)
MIGRATION="$DIR/20261102120000_admin_head_only.sql"
ROLLBACK=$(sed -n '/^-- Rollback/,/^--$/p' "$MIGRATION" | sed -n 's/^--   //p')
P=a1000000-0000-4000-8000-0000000000e1   # ordinary admin (is_head false)
H=a1000000-0000-4000-8000-0000000000e2   # head admin
O=a1000000-0000-4000-8000-0000000000e3   # owner (is_head and is_owner)
U=a1000000-0000-4000-8000-0000000000e4   # plain user, target of the admin calls
T=a1000000-0000-4000-8000-0000000000e5   # deleted by the head admin
T2=a1000000-0000-4000-8000-0000000000e6  # deleted by the owner
key() { printf 'a1a1a1a1-0000-4000-8000-%012d' "$1"; }
run() { jq -Rs '{query: ., read_only: false}' | curl -sS -X POST "https://api.supabase.com/v1/projects/$REF/database/query" -H 'Content-Type: application/json' --data-binary @-; echo; }

HAS=$(echo "select has_function_privilege('authenticated', 'private.is_head_admin()', 'execute') as g;" | run)
if printf '%s' "$HAS" | grep -q '"g":false'; then PRE=$(cat "$MIGRATION"); echo "migration not applied: applying it inside the rolled-back request"; else PRE=""; fi

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
-- The four restricted calls as one admin, with keys starting at n. The periods are written back
-- with their current values.
create function pg_temp.restricted(p_uid uuid, p_target uuid, n int) returns text language plpgsql as \$f\$
declare o public.option_periods; x public.fx_periods; r text := '';
begin
  select * into o from public.option_periods where duration_s = 30;
  select * into x from public.fx_periods where duration_s = 3600;
  r := r || 'adjust:' || pg_temp.as_role('authenticated', p_uid, 'admin', format('select (public.admin_adjust_balance(%L, ''options'', 100, %L)).action', '$U', format('a1a1a1a1-0000-4000-8000-%s', lpad(n::text, 12, '0')))) || ',';
  r := r || 'option:' || pg_temp.as_role('authenticated', p_uid, 'admin', format('select (public.admin_set_option_period(30, %s, %s, %s, %L)).duration_s::text', o.profit_rate_bps, o.fee_bps, o.min_premium_cents, o.enabled)) || ',';
  r := r || 'fx:' || pg_temp.as_role('authenticated', p_uid, 'admin', format('select (public.admin_set_fx_period(3600, %s, %s, %s, %L)).duration_s::text', x.profit_rate_bps, x.fee_bps, x.min_premium_cents, x.enabled)) || ',';
  r := r || 'delete:' || pg_temp.as_role('authenticated', p_uid, 'admin', format('select (public.admin_delete_user(%L, %L)).action', p_target, format('a1a1a1a1-0000-4000-8000-%s', lpad((n + 1)::text, 12, '0'))));
  return r;
end \$f\$;
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', v.id, 'authenticated', 'authenticated', 'tiers-test-' || v.n || '@aureonx.invalid', '', now(), '{}', '{}', now(), now()
from (values ('$P'::uuid, 'p'), ('$H'::uuid, 'h'), ('$O'::uuid, 'o'), ('$U'::uuid, 'u'), ('$T'::uuid, 't'), ('$T2'::uuid, 't2')) v(id, n);
insert into public.user_roles (user_id, role, is_head, is_owner) values ('$P', 'admin', false, false), ('$H', 'admin', true, false), ('$O', 'admin', true, true);
do \$t\$
declare r text := '';
begin
  r := r || 'p_tier=' || pg_temp.as_role('authenticated', '$P', 'admin', 'select private.is_head_admin()::text') || ';';
  r := r || 'h_tier=' || pg_temp.as_role('authenticated', '$H', 'admin', 'select private.is_head_admin()::text') || ';';
  r := r || 'anon_tier=' || pg_temp.as_role('anon', null, 'user', 'select private.is_head_admin()::text') || ';';
  r := r || 'owner_fn=' || pg_temp.as_role('authenticated', '$O', 'admin', 'select private.is_owner()::text') || ';';
  r := r || 'p_restricted=' || pg_temp.restricted('$P', '$T', 1) || ';';
  r := r || 'p_no_audit=' || (select count(*) from public.admin_audit_log where admin_id = '$P') || ';';
  r := r || 'p_target_kept=' || (select count(*) from public.profiles where id = '$T') || ';';
  r := r || 'p_audit_read=' || pg_temp.as_role('authenticated', '$P', 'admin', 'select count(*)::text from public.admin_audit_log') || ';';
  r := r || 'claim_no_row_audit_read=' || pg_temp.as_role('authenticated', '$U', 'admin', 'select count(*)::text from public.admin_audit_log') || ';';
  r := r || 'h_restricted=' || pg_temp.restricted('$H', '$T', 11) || ';';
  r := r || 'h_audit_read=' || pg_temp.as_role('authenticated', '$H', 'admin', 'select (count(*) > 0)::text from public.admin_audit_log') || ';';
  r := r || 'o_restricted=' || pg_temp.restricted('$O', '$T2', 21) || ';';
  r := r || 'o_audit_read=' || pg_temp.as_role('authenticated', '$O', 'admin', 'select (count(*) > 0)::text from public.admin_audit_log') || ';';
  r := r || 'p_suspend=' || pg_temp.as_role('authenticated', '$P', 'admin', 'select (public.admin_set_suspension(''$U'', true, ''$(key 31)'')).action') || ';';
  r := r || 'p_withdraw=' || pg_temp.as_role('authenticated', '$P', 'admin', 'select (public.admin_set_withdraw_restriction(''$U'', true, ''$(key 32)'')).action') || ';';
  r := r || 'p_outcome=' || pg_temp.as_role('authenticated', '$P', 'admin', 'select (public.admin_set_outcome_override(''tiers-test-u@aureonx.invalid'', ''force_loss'', 50, ''$(key 33)'')).action') || ';';
  r := r || 'p_outcome_clear=' || pg_temp.as_role('authenticated', '$P', 'admin', 'select (public.admin_clear_outcome_override(''$U'', ''$(key 34)'')).action') || ';';
  r := r || 'p_wallets_read=' || pg_temp.as_role('authenticated', '$P', 'admin', 'select count(*)::text from public.wallets where user_id = ''$U''') || ';';
  r := r || 'p_ledger_read=' || pg_temp.as_role('authenticated', '$P', 'admin', 'select count(*)::text from public.ledger where user_id = ''$U''') || ';';
  r := r || 'p_profiles_read=' || pg_temp.as_role('authenticated', '$P', 'admin', 'select count(*)::text from public.profiles where id = ''$U''') || ';';
  r := r || 'p_roles_read=' || pg_temp.as_role('authenticated', '$P', 'admin', 'select count(*)::text from public.user_roles where user_id = ''$H''') || ';';
  r := r || 'p_outcome_read=' || pg_temp.as_role('authenticated', '$P', 'admin', 'select count(*)::text from public.outcome_config') || ';';
  r := r || 'p_kyc_read=' || pg_temp.as_role('authenticated', '$P', 'admin', 'select (count(*) >= 0)::text from public.kyc_submissions') || ';';
  r := r || 'p_tickets_read=' || pg_temp.as_role('authenticated', '$P', 'admin', 'select (count(*) >= 0)::text from public.support_tickets') || ';';
  $ROLLBACK
  r := r || 'rb_p_adjust=' || pg_temp.as_role('authenticated', '$P', 'admin', 'select (public.admin_adjust_balance(''$U'', ''options'', 100, ''$(key 41)'')).action') || ';';
  r := r || 'rb_p_audit_read=' || pg_temp.as_role('authenticated', '$P', 'admin', 'select (count(*) > 0)::text from public.admin_audit_log') || ';';
  r := r || 'rb_grant=' || has_function_privilege('authenticated', 'private.is_head_admin()', 'execute') || ';';
  r := r || 'rb_bodies=' || (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and prosrc like '%is_head_admin%' and proname in ('admin_adjust_balance', 'admin_set_option_period', 'admin_set_fx_period', 'admin_delete_user')) || ';';
  raise exception 'RESULTS %', r;
end \$t\$;
SQL
)

FAILS=0
[ -n "${DEBUG:-}" ] && printf "%s\n" "$OUT" | tr ";" "\n"
expect() { if printf '%s' "$OUT" | grep -Eq "$2"; then echo "PASS $1"; else echo "FAIL $1 (expected /$2/)"; FAILS=$((FAILS+1)); fi; }
expect "an ordinary admin is not a head admin" 'p_tier=false;'
expect "a head admin is a head admin" 'h_tier=true;'
expect "anon cannot call is_head_admin" 'anon_tier=ERR permission denied for (schema private|function is_head_admin);'
expect "is_owner stays not callable by authenticated" 'owner_fn=ERR permission denied for function is_owner;'
expect "an ordinary admin is FORBIDDEN on all four RPCs" 'p_restricted=adjust:ERR FORBIDDEN,option:ERR FORBIDDEN,fx:ERR FORBIDDEN,delete:ERR FORBIDDEN;'
expect "the refused calls wrote no audit row" 'p_no_audit=0;'
expect "the refused delete kept the user" 'p_target_kept=1;'
expect "an ordinary admin reads no audit rows" 'p_audit_read=0;'
expect "an admin claim without a row reads no audit rows" 'claim_no_row_audit_read=0;'
expect "a head admin runs all four RPCs" 'h_restricted=adjust:adjust_balance,option:30,fx:3600,delete:delete_user;'
expect "a head admin reads the audit log" 'h_audit_read=true;'
expect "the owner runs all four RPCs" 'o_restricted=adjust:adjust_balance,option:30,fx:3600,delete:delete_user;'
expect "the owner reads the audit log" 'o_audit_read=true;'
expect "an ordinary admin still suspends" 'p_suspend=suspend;'
expect "an ordinary admin still restricts withdrawals" 'p_withdraw=withdraw_restrict;'
expect "an ordinary admin still sets an outcome override" 'p_outcome=outcome_override_set;'
expect "an ordinary admin still clears an outcome override" 'p_outcome_clear=outcome_override_clear;'
expect "an ordinary admin still reads wallets" 'p_wallets_read=4;'
expect "an ordinary admin still reads the ledger (User Search Bills)" 'p_ledger_read=[1-9]'
expect "an ordinary admin still reads profiles" 'p_profiles_read=1;'
expect "an ordinary admin still reads user_roles" 'p_roles_read=1;'
expect "an ordinary admin still reads outcome_config" 'p_outcome_read=1;'
expect "an ordinary admin still reads kyc_submissions" 'p_kyc_read=true;'
expect "an ordinary admin still reads support_tickets" 'p_tickets_read=true;'
expect "rollback: an ordinary admin adjusts again" 'rb_p_adjust=adjust_balance;'
expect "rollback: an ordinary admin reads the audit log again" 'rb_p_audit_read=true;'
expect "rollback: the grant is gone" 'rb_grant=false;'
expect "rollback: no body checks is_head_admin" 'rb_bodies=0;'
if printf '%s' "$OUT" | grep -q 'RESULTS'; then :; else echo "unexpected output: $OUT"; FAILS=$((FAILS+1)); fi
echo "failures: $FAILS"
exit $((FAILS > 0))
