#!/bin/bash
# Test for 20261030130000_option_min_premium_floor: an enabled option period needs
# (profit_rate_bps - fee_bps) x min_premium_cents > 20000. Prints PASS/FAIL lines (no keys)
# and exits non-zero if any check fails.
# Usage: supabase/tests/option_premium_floor.sh  (Management API, write token required;
# run it only after the migration is applied)
# Every write runs inside a transaction that is rolled back, so option_periods and the audit
# log are never changed. Setup adds a test admin; a trap on EXIT, INT, TERM and ERR deletes it.
# The project comes from SUPABASE_PROJECT_REF; abort before any query unless it matches the
# ref in NEXT_PUBLIC_SUPABASE_URL.
REF=${SUPABASE_PROJECT_REF:?SUPABASE_PROJECT_REF is not set}
URL_REF=$(printf '%s' "${NEXT_PUBLIC_SUPABASE_URL:-}" | sed -nE 's#^https://([a-z0-9]+)\.supabase\.co/?$#\1#p')
if [ "$REF" != "$URL_REF" ]; then echo "SUPABASE_PROJECT_REF does not match NEXT_PUBLIC_SUPABASE_URL; aborting." >&2; exit 1; fi
B=bbbbbbbb-0000-4000-8000-0000000000b1   # admin
FAILS=0
run() { jq -Rs '{query: ., read_only: false}' | curl -sS -X POST "https://api.supabase.com/v1/projects/$REF/database/query" -H 'Content-Type: application/json' --data-binary @-; echo; }
expect() { if printf '%s' "$3" | grep -Eq "$2"; then echo "PASS $1"; else echo "FAIL $1 (expected /$2/): $3"; FAILS=$((FAILS+1)); fi; }
# set_period <duration> <rate bps> <fee bps> <min premium cents> <enabled>: as the admin, rolled back.
set_period() { run <<SQL
begin;
select set_config('request.jwt.claims', json_build_object('sub','$B','role','authenticated','aal','aal1','user_role','admin')::text, true);
set local role authenticated;
select min_premium_cents from public.admin_set_option_period($1, $2, $3, $4, $5);
rollback;
SQL
}
cleanup() { trap - EXIT INT TERM ERR; run <<SQL > /dev/null
delete from public.admin_audit_log where admin_id = '$B';
delete from auth.users where id = '$B';
SQL
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM
trap 'cleanup; exit 1' ERR
run <<SQL > /dev/null
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000','$B','authenticated','authenticated','floor-test-b@aureonx.invalid','',now(),'{}','{"nickname":"TestB"}',now(),now());
insert into public.user_roles (user_id, role) values ('$B','admin');
SQL

echo "T1 600 bps, 10 bps fee: floor is 34 cents"
expect "33 cents is refused" 'option_periods_min_premium_floor' "$(set_period 30 600 10 33 true)"
expect "34 cents is accepted" '"min_premium_cents":34' "$(set_period 30 600 10 34 true)"
expect "the live minimum (4900) is accepted" '"min_premium_cents":4900' "$(set_period 30 600 10 4900 true)"
echo "T2 a lower rate raises the floor: 100 bps, 10 bps fee needs 223 cents"
expect "222 cents is refused" 'option_periods_min_premium_floor' "$(set_period 30 100 10 222 true)"
expect "223 cents is accepted" '"min_premium_cents":223' "$(set_period 30 100 10 223 true)"
echo "T3 a rate not above the fee can never be enabled"
expect "10 bps rate, 10 bps fee, any premium refused" 'option_periods_min_premium_floor' "$(set_period 30 10 10 1000000 true)"
echo "T4 a disabled period is exempt"
expect "disabled with 1 cent is accepted" '"min_premium_cents":1' "$(set_period 60 0 10 1 false)"
echo "T5 a direct write is refused too"
out=$(run <<SQL
begin;
update public.option_periods set min_premium_cents = 1 where duration_s = 30;
rollback;
SQL
)
expect "direct update below the floor" 'option_periods_min_premium_floor' "$out"
if [ $FAILS -gt 0 ]; then echo "$FAILS check(s) failed"; exit 1; fi
echo "all checks passed"
