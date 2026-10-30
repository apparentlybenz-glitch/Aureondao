#!/bin/bash
# Owner tier tests (user_roles.is_owner, private.is_owner, admin_demote_head, and admin_set_admin
# still refusing head targets). Prints PASS/FAIL lines (no keys) and exits non-zero if any check fails.
# Usage: supabase/tests/owner_tier.sh [t1 ... t7]  (Management API, write token required)
# Always runs setup, the given steps (all by default), then cleanup, in one process. Setup creates the
# only owners and head admins the script ever uses (two test owners, three test head admins, one plain
# admin, one plain user, all inserted as postgres); a trap on EXIT, INT, TERM and ERR runs cleanup, which
# deletes the test users (user_roles rows cascade) and their audit rows, then checks that no test
# user_roles row, and so no test owner or head admin, is left and that the count of real rows with
# is_head or is_owner is what it was before setup. Real user_roles rows are never touched.
# The project comes from SUPABASE_PROJECT_REF; abort before any query unless it matches the
# ref in NEXT_PUBLIC_SUPABASE_URL.
REF=${SUPABASE_PROJECT_REF:?SUPABASE_PROJECT_REF is not set}
URL_REF=$(printf '%s' "${NEXT_PUBLIC_SUPABASE_URL:-}" | sed -nE 's#^https://([a-z0-9]+)\.supabase\.co/?$#\1#p')
if [ "$REF" != "$URL_REF" ]; then echo "SUPABASE_PROJECT_REF does not match NEXT_PUBLIC_SUPABASE_URL; aborting." >&2; exit 1; fi
O=ad000000-0000-4000-8000-0000000000b1   # owner
O2=ad000000-0000-4000-8000-0000000000b2  # second owner row
H=ad000000-0000-4000-8000-0000000000b3   # head admin, removed in t4
H2=ad000000-0000-4000-8000-0000000000b4  # head admin, demoted in t3
H3=ad000000-0000-4000-8000-0000000000b5  # head admin, never touched by the owner
P=ad000000-0000-4000-8000-0000000000b6   # plain admin (is_head false)
U=ad000000-0000-4000-8000-0000000000b7   # plain user, never an admin
IDS="'$O','$O2','$H','$H2','$H3','$P','$U'"
FAILS=0
run() { jq -Rs '{query: ., read_only: false}' | curl -sS -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" -H 'Content-Type: application/json' --data-binary @-; echo; }
# as <uid> <aal> <user_role> <sql>
as() { run <<SQL
begin;
select set_config('request.jwt.claims', json_build_object('sub','$1','role','authenticated','aal','$2','user_role','$3')::text, true);
set local role authenticated;
$4
commit;
SQL
}
anon() { run <<SQL
begin;
set local role anon;
$1
commit;
SQL
}
owner() { as $O aal1 admin "$1"; }
head3() { as $H3 aal1 admin "$1"; }
# expect <label> <extended regex> <output>
expect() { if printf '%s' "$3" | grep -Eq "$2"; then echo "PASS $1"; else echo "FAIL $1 (expected /$2/): $3"; FAILS=$((FAILS+1)); fi; }
key() { printf '99999999-0000-4000-8000-%012d' "$1"; }
# demote <caller fn> <user> <remove> <reason sql literal> <key>
demote() { $1 "select (public.admin_demote_head('$2', $3, $4, '$5')).action;"; }
setadmin() { $1 "select (public.admin_set_admin('$2', $3, $4, '$5')).action;"; }
roles() { echo "select count(*) n, coalesce(bool_or(is_head), false) h, coalesce(bool_or(is_owner), false) o from public.user_roles where user_id = '$1' and role = 'admin';" | run; }
audits() { echo "select count(*) n from public.admin_audit_log where action in ('head_demote','head_remove') and (admin_id in ($IDS) or target_user_id in ($IDS));" | run; }
# Real and test rows with is_head or is_owner, as a bare number.
privileged() { echo "select count(*) n from public.user_roles where is_head or is_owner;" | run | jq -r '.[0].n'; }

step() {
case "$1" in
setup) run <<SQL
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', v.id, 'authenticated', 'authenticated', 'ownertier-test-' || v.n || '@aureonx.invalid', '', now(), '{}', json_build_object('nickname','Test' || v.n)::jsonb, now(), now()
from (values ('$O'::uuid,'o'),('$O2','o2'),('$H','h'),('$H2','h2'),('$H3','h3'),('$P','p'),('$U','u')) v(id, n);
insert into public.user_roles (user_id, role, is_head, is_owner)
values ('$O','admin',true,true), ('$O2','admin',true,true), ('$H','admin',true,false), ('$H2','admin',true,false), ('$H3','admin',true,false), ('$P','admin',false,false);
select user_id, role, is_head, is_owner from public.user_roles where user_id in ($IDS) order by user_id;
SQL
    ;;
t1) echo "T1 admin_demote_head: every caller who is not the owner is refused; nothing changes"
    K=$(key 1)
    expect "anon -> denied" 'permission denied' "$(anon "select (public.admin_demote_head('$H2', false, 'step down', '$K')).action;")"
    expect "no user id -> UNAUTHENTICATED" UNAUTHENTICATED "$(run <<SQL
begin;
select set_config('request.jwt.claims', json_build_object('role','authenticated','aal','aal1','user_role','user')::text, true);
set local role authenticated;
select (public.admin_demote_head('$H2', false, 'step down', '$K')).action;
commit;
SQL
)"
    expect "plain user -> FORBIDDEN" FORBIDDEN "$(demote "as $U aal1 user" $H2 false "'step down'" $K)"
    expect "plain user with an admin claim and no admin row -> FORBIDDEN" FORBIDDEN "$(demote "as $U aal1 admin" $H2 false "'step down'" $K)"
    expect "plain admin -> FORBIDDEN" FORBIDDEN "$(demote "as $P aal1 admin" $H2 false "'step down'" $K)"
    expect "head admin (not owner) demote -> FORBIDDEN" FORBIDDEN "$(demote head3 $H2 false "'step down'" $K)"
    expect "head admin (not owner) remove -> FORBIDDEN" FORBIDDEN "$(demote head3 $H2 true "'step down'" $K)"
    expect "head admin (not owner) targeting the owner -> FORBIDDEN" FORBIDDEN "$(demote head3 $O false "'step down'" $K)"
    expect "owner row with a user claim -> FORBIDDEN" FORBIDDEN "$(demote "as $O aal1 user" $H2 false "'step down'" $K)"
    expect "the target is still a head admin" '"n":1,"h":true,"o":false' "$(roles $H2)"
    expect "no audit row" '"n":0' "$(audits)";;
t2) echo "T2 argument checks as the owner; nothing changes"
    K=$(key 2); LONG=$(printf 'x%.0s' $(seq 1 201))
    expect "no reason -> NOTE_REQUIRED" NOTE_REQUIRED "$(demote owner $H2 false null $K)"
    expect "whitespace reason -> NOTE_REQUIRED" NOTE_REQUIRED "$(demote owner $H2 false "'   '" $K)"
    expect "reason of 2 characters -> NOTE_REQUIRED" NOTE_REQUIRED "$(demote owner $H2 false "'ab'" $K)"
    expect "reason of 201 characters -> NOTE_REQUIRED" NOTE_REQUIRED "$(demote owner $H2 true "'$LONG'" $K)"
    expect "reason of 3 characters passes validation (then NOT_HEAD_ADMIN for a plain admin)" NOT_HEAD_ADMIN "$(demote owner $P false "'abc'" $(key 21))"
    expect "no key -> INVALID_ARGUMENT" INVALID_ARGUMENT "$(owner "select (public.admin_demote_head('$H3', false, 'step down', null)).action;")"
    expect "no remove flag -> INVALID_ARGUMENT" INVALID_ARGUMENT "$(owner "select (public.admin_demote_head('$H3', null, 'step down', '$K')).action;")"
    expect "no target -> INVALID_ARGUMENT" INVALID_ARGUMENT "$(owner "select (public.admin_demote_head(null, false, 'step down', '$K')).action;")"
    expect "the head admins are untouched" '"n":3' "$(echo "select count(*) n from public.user_roles where user_id in ('$H','$H2','$H3') and role = 'admin' and is_head;" | run)"
    expect "no audit row" '"n":0' "$(audits)";;
t3) echo "T3 owner demotes a head admin to admin; replay"
    K=$(key 3)
    expect "demote returns the audit row" 'head_demote' "$(demote owner $H false "'back to admin'" $K)"
    expect "the row stays with is_head false" '"n":1,"h":false,"o":false' "$(roles $H)"
    expect "audit row has admin, target and reason" '"n":1,"r":"back to admin"' "$(echo "select count(*) n, min(payload ->> 'reason') r from public.admin_audit_log where client_request_id = '$K' and action = 'head_demote' and admin_id = '$O' and target_user_id = '$H';" | run)"
    demote owner $H false "'back to admin'" $K > /dev/null
    expect "same key twice: one audit row" '"n":1' "$(echo "select count(*) n from public.admin_audit_log where client_request_id = '$K';" | run)"
    expect "same key twice: the row is unchanged" '"n":1,"h":false,"o":false' "$(roles $H)"
    expect "same key, other reason -> IDEMPOTENCY_CONFLICT" IDEMPOTENCY_CONFLICT "$(demote owner $H false "'other reason'" $K)"
    expect "same key, remove instead of demote -> IDEMPOTENCY_CONFLICT" IDEMPOTENCY_CONFLICT "$(demote owner $H true "'back to admin'" $K)"
    expect "same key, other user -> IDEMPOTENCY_CONFLICT" IDEMPOTENCY_CONFLICT "$(demote owner $H3 false "'back to admin'" $K)"
    expect "demoted again with a new key -> NOT_HEAD_ADMIN" NOT_HEAD_ADMIN "$(demote owner $H false "'back to admin'" $(key 31))"
    expect "the demoted admin is no head admin: admin_set_admin -> FORBIDDEN" 'FORBIDDEN' "$(setadmin "as $H aal1 admin" $U true "'new colleague'" $(key 32))"
    expect "no extra audit row for the refused call" '"n":0' "$(echo "select count(*) n from public.admin_audit_log where client_request_id = '$(key 31)';" | run)";;
t4) echo "T4 owner removes a head admin; replay"
    K=$(key 4)
    expect "remove returns the audit row" 'head_remove' "$(demote owner $H3 true "'left the team'" $K)"
    expect "the row is gone" '"n":0' "$(roles $H3)"
    expect "audit row has admin, target and reason" '"n":1,"r":"left the team"' "$(echo "select count(*) n, min(payload ->> 'reason') r from public.admin_audit_log where client_request_id = '$K' and action = 'head_remove' and admin_id = '$O' and target_user_id = '$H3';" | run)"
    demote owner $H3 true "'left the team'" $K > /dev/null
    expect "same key twice: one audit row" '"n":1' "$(echo "select count(*) n from public.admin_audit_log where client_request_id = '$K';" | run)"
    expect "same key, other reason -> IDEMPOTENCY_CONFLICT" IDEMPOTENCY_CONFLICT "$(demote owner $H3 true "'other reason'" $K)"
    expect "same key, demote instead of remove -> IDEMPOTENCY_CONFLICT" IDEMPOTENCY_CONFLICT "$(demote owner $H3 false "'left the team'" $K)"
    expect "removed again with a new key -> NOT_HEAD_ADMIN" NOT_HEAD_ADMIN "$(demote owner $H3 true "'left the team'" $(key 41))"
    expect "the removed admin's tools stop at once (RLS read of other profiles)" '"n":0' "$(as $H3 aal1 admin "select count(*) n from public.profiles where id <> '$H3';")"
    expect "the removed admin's RPCs are refused" FORBIDDEN "$(setadmin "as $H3 aal1 admin" $U true "'new colleague'" $(key 42))";;
t5) echo "T5 the owner cannot be demoted or removed; other non-head targets"
    expect "owner targets self, demote -> OWNER_PROTECTED" OWNER_PROTECTED "$(demote owner $O false "'stepping down'" $(key 5))"
    expect "owner targets self, remove -> OWNER_PROTECTED" OWNER_PROTECTED "$(demote owner $O true "'stepping down'" $(key 51))"
    expect "owner targets another owner row -> OWNER_PROTECTED" OWNER_PROTECTED "$(demote owner $O2 true "'not needed'" $(key 52))"
    expect "both owner rows are intact" '"n":2' "$(echo "select count(*) n from public.user_roles where user_id in ('$O','$O2') and role = 'admin' and is_head and is_owner;" | run)"
    expect "plain admin target -> NOT_HEAD_ADMIN" NOT_HEAD_ADMIN "$(demote owner $P true "'not needed'" $(key 53))"
    expect "plain user target -> NOT_HEAD_ADMIN" NOT_HEAD_ADMIN "$(demote owner $U true "'not needed'" $(key 54))"
    expect "unknown user target -> NOT_HEAD_ADMIN" NOT_HEAD_ADMIN "$(demote owner 00000000-0000-4000-8000-000000000001 true "'not needed'" $(key 55))"
    expect "the plain admin is still there" '"n":1,"h":false' "$(roles $P)"
    expect "no audit row for the refused calls" '"n":0' "$(echo "select count(*) n from public.admin_audit_log where client_request_id in ('$(key 5)','$(key 51)','$(key 52)','$(key 53)','$(key 54)','$(key 55)');" | run)";;
t6) echo "T6 admin_set_admin still refuses head admin and owner targets, for the owner and for a head admin"
    expect "owner revokes a head admin -> HEAD_ADMIN_PROTECTED" HEAD_ADMIN_PROTECTED "$(setadmin owner $H2 false "'not needed'" $(key 6))"
    expect "head admin revokes another head admin -> HEAD_ADMIN_PROTECTED" HEAD_ADMIN_PROTECTED "$(setadmin "as $H2 aal1 admin" $O2 false "'not needed'" $(key 61))"
    expect "head admin revokes the owner -> HEAD_ADMIN_PROTECTED" HEAD_ADMIN_PROTECTED "$(setadmin "as $H2 aal1 admin" $O false "'not needed'" $(key 62))"
    expect "owner revokes another owner row -> HEAD_ADMIN_PROTECTED" HEAD_ADMIN_PROTECTED "$(setadmin owner $O2 false "'not needed'" $(key 63))"
    expect "owner revokes itself -> HEAD_ADMIN_PROTECTED" HEAD_ADMIN_PROTECTED "$(setadmin owner $O false "'stepping down'" $(key 64))"
    expect "a head admin still grants and revokes plain admins" 'admin_grant' "$(setadmin "as $H2 aal1 admin" $U true "'new colleague'" $(key 65))"
    expect "and the revoke" 'admin_revoke' "$(setadmin "as $H2 aal1 admin" $U false "'left the team'" $(key 66))"
    expect "the head admin and the owners are intact" '"n":3' "$(echo "select count(*) n from public.user_roles where user_id in ('$H2','$O','$O2') and role = 'admin' and is_head;" | run)"
    expect "no audit row for the refused calls" '"n":0' "$(echo "select count(*) n from public.admin_audit_log where client_request_id in ('$(key 6)','$(key 61)','$(key 62)','$(key 63)','$(key 64)');" | run)";;
t7) echo "T7 no client write to user_roles, reads work, nothing can create a head admin or owner"
    expect "user insert -> denied" 'permission denied' "$(as $U aal1 user "insert into public.user_roles (user_id, role) values ('$U','admin');")"
    expect "user insert with is_owner -> denied" 'permission denied' "$(as $U aal1 user "insert into public.user_roles (user_id, role, is_head, is_owner) values ('$U','admin',true,true);")"
    expect "owner insert -> denied" 'permission denied' "$(owner "insert into public.user_roles (user_id, role) values ('$U','admin');")"
    expect "owner update is_head -> denied" 'permission denied' "$(owner "update public.user_roles set is_head = true where user_id = '$P';")"
    expect "owner update is_owner -> denied" 'permission denied' "$(owner "update public.user_roles set is_owner = true where user_id = '$H2';")"
    expect "owner delete -> denied" 'permission denied' "$(owner "delete from public.user_roles where user_id = '$H2';")"
    expect "head admin update is_owner on its own row -> denied" 'permission denied' "$(as $H2 aal1 admin "update public.user_roles set is_owner = true where user_id = '$H2';")"
    expect "plain admin update is_head on its own row -> denied" 'permission denied' "$(as $P aal1 admin "update public.user_roles set is_head = true where user_id = '$P';")"
    expect "plain user delete -> denied" 'permission denied' "$(as $U aal1 user "delete from public.user_roles where user_id = '$O';")"
    expect "anon insert -> denied" 'permission denied' "$(anon "insert into public.user_roles (user_id, role, is_owner) values ('$U','admin',true);")"
    expect "anon update -> denied" 'permission denied' "$(anon "update public.user_roles set is_owner = true;")"
    expect "anon delete -> denied" 'permission denied' "$(anon "delete from public.user_roles;")"
    expect "anon read -> denied" 'permission denied' "$(anon "select is_owner from public.user_roles;")"
    expect "private.is_owner is not callable by authenticated" 'permission denied' "$(owner "select private.is_owner();")"
    expect "the CHECK refuses an owner who is not a head admin (as postgres)" 'user_roles_owner_is_head' "$(echo "update public.user_roles set is_owner = true where user_id = '$P';" | run)"
    expect "the owner reads its own is_owner (what the Admin access section reads)" '"is_owner":true' "$(owner "select is_owner from public.user_roles where user_id = '$O' and role = 'admin';")"
    expect "a plain admin reads its own is_owner as false" '"is_owner":false' "$(as $P aal1 admin "select is_owner from public.user_roles where user_id = '$P' and role = 'admin';")"
    expect "an admin reads another user's is_owner (the target state)" '"is_owner":true' "$(as $P aal1 admin "select is_owner from public.user_roles where user_id = '$O2' and role = 'admin';")"
    expect "a plain user reads no admin row of its own" '"n":0' "$(as $U aal1 user "select count(*) n from public.user_roles where user_id = '$U' and role = 'admin';")"
    expect "the access token hook still sets the claim: admin" '"user_role":"admin"' "$(echo "select public.custom_access_token_hook(jsonb_build_object('user_id','$O','claims','{}'::jsonb)) -> 'claims' as c;" | run)"
    expect "the access token hook still sets the claim: user" '"user_role":"user"' "$(echo "select public.custom_access_token_hook(jsonb_build_object('user_id','$U','claims','{}'::jsonb)) -> 'claims' as c;" | run)"
    NOW=$(privileged)
    if [ "$NOW" -le "$BASE" ]; then echo "PASS rows with is_head or is_owner never increased ($BASE before the steps, $NOW now)"; else echo "FAIL rows with is_head or is_owner increased ($BASE before the steps, $NOW now)"; FAILS=$((FAILS+1)); fi;;
cleanup) run <<SQL
delete from public.admin_audit_log where admin_id in ($IDS) or target_user_id in ($IDS);
delete from auth.users where id in ($IDS);
select (select count(*) from public.profiles where id in ($IDS)) profiles,
       (select count(*) from public.user_roles where user_id in ($IDS)) roles,
       (select count(*) from public.user_roles where user_id in ($IDS) and (is_head or is_owner)) test_privileged,
       (select count(*) from public.admin_audit_log where admin_id in ($IDS) or target_user_id in ($IDS)) audit_rows;
SQL
;;
*) echo "unknown step $1"; exit 1;;
esac
}

set -E
restored=0
BEFORE=$(privileged)
restore() {
  [ "$restored" = 1 ] && return 0
  restored=1; trap - EXIT INT TERM ERR
  echo "== cleanup (deletes the test users, their roles and audit rows)"
  expect "no test user, role, owner, head admin or audit row left" '"profiles":0,"roles":0,"test_privileged":0,"audit_rows":0' "$(step cleanup)"
  AFTER=$(privileged)
  if [ "$AFTER" = "$BEFORE" ]; then echo "PASS rows with is_head or is_owner are back to $BEFORE"; else echo "FAIL rows with is_head or is_owner: $BEFORE before, $AFTER after"; FAILS=$((FAILS+1)); fi
}
trap restore EXIT
trap 'restore; exit 130' INT
trap 'restore; exit 143' TERM
trap 'restore; exit 1' ERR

steps=("$@"); [ ${#steps[@]} -eq 0 ] && steps=(t1 t2 t3 t4 t5 t6 t7)
step setup
BASE=$(privileged)
for s in "${steps[@]}"; do step "$s"; echo; done
restore
echo "== $FAILS check(s) failed"
exit $FAILS
