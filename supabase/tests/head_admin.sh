#!/bin/bash
# Head admin tests (user_roles.is_head, private.is_head_admin, admin_set_admin). Prints PASS/FAIL lines
# (no keys) and exits non-zero if any check fails.
# Usage: supabase/tests/head_admin.sh [t1 ... t7]  (Management API, write token required)
# Always runs setup, the given steps (all by default), then cleanup, in one process. Setup creates the
# only head admins the script ever uses (two test users, inserted as postgres); a trap on EXIT, INT, TERM
# and ERR runs cleanup, which deletes the test users (user_roles rows cascade) and their audit rows, then
# checks that no test user_roles row, and so no test head admin, is left. Real user_roles rows are never touched.
# The project comes from SUPABASE_PROJECT_REF; abort before any query unless it matches the
# ref in NEXT_PUBLIC_SUPABASE_URL.
REF=${SUPABASE_PROJECT_REF:?SUPABASE_PROJECT_REF is not set}
URL_REF=$(printf '%s' "${NEXT_PUBLIC_SUPABASE_URL:-}" | sed -nE 's#^https://([a-z0-9]+)\.supabase\.co/?$#\1#p')
if [ "$REF" != "$URL_REF" ]; then echo "SUPABASE_PROJECT_REF does not match NEXT_PUBLIC_SUPABASE_URL; aborting." >&2; exit 1; fi
H=ad000000-0000-4000-8000-0000000000a1   # head admin
H2=ad000000-0000-4000-8000-0000000000a2  # second head admin
P=ad000000-0000-4000-8000-0000000000a3   # plain admin (is_head false)
N=ad000000-0000-4000-8000-0000000000a4   # user granted admin by the head admin
U=ad000000-0000-4000-8000-0000000000a5   # plain user, never an admin
IDS="'$H','$H2','$P','$N','$U'"
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
anon() { run <<SQL
begin;
set local role anon;
$1
commit;
SQL
}
hadm() { as $H aal1 admin "$1"; }
# expect <label> <extended regex> <output>
expect() { if printf '%s' "$3" | grep -Eq "$2"; then echo "PASS $1"; else echo "FAIL $1 (expected /$2/): $3"; FAILS=$((FAILS+1)); fi; }
key() { printf '88888888-0000-4000-8000-%012d' "$1"; }
# grant_to <user> <key>: admin_set_admin(..., true, ...) as the head admin.
grant_to() { hadm "select (public.admin_set_admin('$1', true, '$2')).action;"; }
revoke_from() { hadm "select (public.admin_set_admin('$1', false, '$2')).action;"; }
roles() { echo "select count(*) n, coalesce(bool_or(is_head), false) h from public.user_roles where user_id = '$1' and role = 'admin';" | run; }
audits() { echo "select count(*) n from public.admin_audit_log where action in ('admin_grant','admin_revoke') and (admin_id in ($IDS) or target_user_id in ($IDS));" | run; }

step() {
case "$1" in
setup) run <<SQL
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', v.id, 'authenticated', 'authenticated', 'headadmin-test-' || v.n || '@aureonx.invalid', '', now(), '{}', json_build_object('nickname','Test' || v.n)::jsonb, now(), now()
from (values ('$H'::uuid,'h'),('$H2','h2'),('$P','p'),('$N','n'),('$U','u')) v(id, n);
insert into public.user_roles (user_id, role, is_head) values ('$H','admin',true), ('$H2','admin',true), ('$P','admin',false);
select user_id, role, is_head from public.user_roles where user_id in ($IDS) order by user_id;
SQL
    ;;
t1) echo "T1 admin_set_admin: every caller who is not a head admin is refused; nothing changes"
    K=$(key 1)
    expect "anon -> denied" 'permission denied' "$(anon "select (public.admin_set_admin('$N', true, '$K')).action;")"
    expect "no user id -> UNAUTHENTICATED" UNAUTHENTICATED "$(run <<SQL
begin;
select set_config('request.jwt.claims', json_build_object('role','authenticated','aal','aal1','user_role','user')::text, true);
set local role authenticated;
select (public.admin_set_admin('$N', true, '$K')).action;
commit;
SQL
)"
    expect "plain user -> FORBIDDEN" FORBIDDEN "$(as $U aal1 user "select (public.admin_set_admin('$N', true, '$K')).action;")"
    expect "plain user with an admin claim and no admin row -> FORBIDDEN" FORBIDDEN "$(as $U aal1 admin "select (public.admin_set_admin('$N', true, '$K')).action;")"
    expect "plain admin (is_head false) grant -> FORBIDDEN" FORBIDDEN "$(as $P aal1 admin "select (public.admin_set_admin('$N', true, '$K')).action;")"
    expect "plain admin revoke -> FORBIDDEN" FORBIDDEN "$(as $P aal1 admin "select (public.admin_set_admin('$H', false, '$K')).action;")"
    expect "head admin row with a user claim -> FORBIDDEN" FORBIDDEN "$(as $H aal1 user "select (public.admin_set_admin('$N', true, '$K')).action;")"
    expect "no user_roles row for the target, no audit row" '"n":0' "$(roles $N)"
    expect "no audit row" '"n":0' "$(audits)";;
t2) echo "T2 argument checks as the head admin; nothing changes"
    K=$(key 2)
    expect "old signature with a reason is gone, new one exists" '"old":0,"new":1' "$(echo "select count(to_regprocedure('public.admin_set_admin(uuid, boolean, text, uuid)')) old, count(to_regprocedure('public.admin_set_admin(uuid, boolean, uuid)')) new;" | run)"
    expect "unknown user -> INVALID_ARGUMENT" INVALID_ARGUMENT "$(grant_to 00000000-0000-4000-8000-000000000001 $K)"
    expect "no key -> INVALID_ARGUMENT" INVALID_ARGUMENT "$(hadm "select (public.admin_set_admin('$N', true, null)).action;")"
    expect "no direction -> INVALID_ARGUMENT" INVALID_ARGUMENT "$(hadm "select (public.admin_set_admin('$N', null, '$K')).action;")"
    expect "no target -> INVALID_ARGUMENT" INVALID_ARGUMENT "$(hadm "select (public.admin_set_admin(null, true, '$K')).action;")"
    expect "the plain admin is still there" '"n":1,"h":false' "$(roles $P)"
    expect "no user_roles row for the target" '"n":0' "$(roles $N)"
    expect "no audit row" '"n":0' "$(audits)";;
t3) echo "T3 head admin grants a user; replay and repeat grants"
    K=$(key 3)
    expect "grant with no reason returns the audit row" 'admin_grant' "$(grant_to $N $K)"
    expect "role row exists with is_head false and granted_by the head admin" '"n":1,"h":false,"g":1' "$(echo "select count(*) n, bool_or(is_head) h, count(*) filter (where granted_by = '$H') g from public.user_roles where user_id = '$N' and role = 'admin';" | run)"
    expect "audit row has admin and target, empty payload, no reason key" '"n":1,"e":true,"r":false' "$(echo "select count(*) n, bool_and(payload = '{}'::jsonb) e, bool_or(payload ? 'reason') r from public.admin_audit_log where client_request_id = '$K' and action = 'admin_grant' and admin_id = '$H' and target_user_id = '$N';" | run)"
    grant_to $N $K > /dev/null
    expect "same key twice: one role row" '"n":1' "$(roles $N)"
    expect "same key twice: one audit row" '"n":1' "$(echo "select count(*) n from public.admin_audit_log where client_request_id = '$K';" | run)"
    expect "same key, other action -> IDEMPOTENCY_CONFLICT" IDEMPOTENCY_CONFLICT "$(revoke_from $N $K)"
    expect "same key, other user -> IDEMPOTENCY_CONFLICT" IDEMPOTENCY_CONFLICT "$(grant_to $U $K)"
    expect "a new key on an existing admin: no second role row" 'admin_grant' "$(grant_to $N $(key 31))"
    expect "still one role row, still not a head, granted_by unchanged" '"n":1,"h":false,"g":1' "$(echo "select count(*) n, bool_or(is_head) h, count(*) filter (where granted_by = '$H') g from public.user_roles where user_id = '$N' and role = 'admin';" | run)";;
t4) echo "T4 the newly granted admin cannot grant or revoke others"
    K=$(key 4)
    expect "admin tools open for the new admin (a read passes)" '"n":[1-9]' "$(as $N aal1 admin "select count(*) n from public.profiles;")"
    expect "grant -> FORBIDDEN" FORBIDDEN "$(as $N aal1 admin "select (public.admin_set_admin('$U', true, '$K')).action;")"
    expect "revoke the plain admin -> FORBIDDEN" FORBIDDEN "$(as $N aal1 admin "select (public.admin_set_admin('$P', false, '$K')).action;")"
    expect "revoke the head admin -> FORBIDDEN" FORBIDDEN "$(as $N aal1 admin "select (public.admin_set_admin('$H', false, '$K')).action;")"
    expect "the user was not granted" '"n":0' "$(roles $U)"
    expect "the plain admin is still there" '"n":1' "$(roles $P)"
    expect "the head admin is still there" '"n":1,"h":true' "$(roles $H)";;
t5) echo "T5 head admin revokes plain admins; replay; no-op revoke"
    K=$(key 5)
    expect "revoke with no reason returns the audit row" 'admin_revoke' "$(revoke_from $P $K)"
    expect "the plain admin's row is gone" '"n":0' "$(roles $P)"
    expect "audit row has admin and target, empty payload, no reason key" '"n":1,"e":true,"r":false' "$(echo "select count(*) n, bool_and(payload = '{}'::jsonb) e, bool_or(payload ? 'reason') r from public.admin_audit_log where client_request_id = '$K' and action = 'admin_revoke' and admin_id = '$H' and target_user_id = '$P';" | run)"
    revoke_from $P $K > /dev/null
    expect "same key twice: one audit row" '"n":1' "$(echo "select count(*) n from public.admin_audit_log where client_request_id = '$K';" | run)"
    expect "revoke the granted admin" 'admin_revoke' "$(revoke_from $N $(key 51))"
    expect "the granted admin's row is gone" '"n":0' "$(roles $N)"
    expect "the revoked admin's tools stop at once (RLS read of other profiles)" '"n":0' "$(as $N aal1 admin "select count(*) n from public.profiles where id <> '$N';")"
    expect "the revoked admin's RPCs are refused" FORBIDDEN "$(as $N aal1 admin "select (public.admin_set_admin('$U', true, '$(key 52)')).action;")"
    expect "revoking a user who is not an admin still writes an audit row" 'admin_revoke' "$(revoke_from $U $(key 53))"
    expect "and creates no role row" '"n":0' "$(roles $U)";;
t6) echo "T6 a head admin cannot be revoked, not even by a head admin or by itself"
    expect "revoke another head admin -> HEAD_ADMIN_PROTECTED" HEAD_ADMIN_PROTECTED "$(revoke_from $H2 $(key 6))"
    expect "revoke itself -> HEAD_ADMIN_PROTECTED" HEAD_ADMIN_PROTECTED "$(revoke_from $H $(key 61))"
    expect "both head admins are still there" '"n":2' "$(echo "select count(*) n from public.user_roles where user_id in ('$H','$H2') and role = 'admin' and is_head;" | run)"
    expect "no audit row for the refused calls" '"n":0' "$(echo "select count(*) n from public.admin_audit_log where client_request_id in ('$(key 6)','$(key 61)');" | run)"
    expect "granting a head admin changes nothing" 'admin_grant' "$(grant_to $H2 $(key 62))"
    expect "it is still a head admin and granted_by is unchanged" '"n":1,"h":true,"g":0' "$(echo "select count(*) n, bool_or(is_head) h, count(*) filter (where granted_by is not null) g from public.user_roles where user_id = '$H2' and role = 'admin';" | run)";;
t7) echo "T7 no client write to user_roles, own reads work, the auth hook still works"
    expect "user insert -> denied" 'permission denied' "$(as $U aal1 user "insert into public.user_roles (user_id, role) values ('$U','admin');")"
    expect "user insert with is_head -> denied" 'permission denied' "$(as $U aal1 user "insert into public.user_roles (user_id, role, is_head) values ('$U','admin',true);")"
    expect "head admin insert -> denied" 'permission denied' "$(hadm "insert into public.user_roles (user_id, role) values ('$U','admin');")"
    expect "head admin update is_head -> denied" 'permission denied' "$(hadm "update public.user_roles set is_head = true where user_id = '$U';")"
    expect "head admin update of its own row -> denied" 'permission denied' "$(hadm "update public.user_roles set is_head = false where user_id = '$H';")"
    expect "head admin delete -> denied" 'permission denied' "$(hadm "delete from public.user_roles where user_id = '$H2';")"
    expect "plain user update -> denied" 'permission denied' "$(as $U aal1 user "update public.user_roles set is_head = true where user_id = '$U';")"
    expect "plain user delete -> denied" 'permission denied' "$(as $U aal1 user "delete from public.user_roles where user_id = '$H';")"
    expect "anon insert -> denied" 'permission denied' "$(anon "insert into public.user_roles (user_id, role, is_head) values ('$U','admin',true);")"
    expect "anon update -> denied" 'permission denied' "$(anon "update public.user_roles set is_head = true;")"
    expect "anon delete -> denied" 'permission denied' "$(anon "delete from public.user_roles;")"
    expect "anon read -> denied" 'permission denied' "$(anon "select is_head from public.user_roles;")"
    expect "private.is_head_admin is not callable by authenticated" 'permission denied' "$(hadm "select private.is_head_admin();")"
    expect "after all attempts: test head admins are exactly H and H2" '"heads":2' "$(echo "select count(*) filter (where is_head) heads from public.user_roles where user_id in ($IDS);" | run)"
    expect "after all attempts: no row for the plain user" '"n":0' "$(roles $U)"
    expect "the head admin reads its own is_head (what the Admin access section reads)" '"is_head":true' "$(hadm "select is_head from public.user_roles where user_id = '$H' and role = 'admin';")"
    expect "a plain user reads no admin row of its own" '"n":0' "$(as $U aal1 user "select count(*) n from public.user_roles where user_id = '$U' and role = 'admin';")"
    expect "an admin reads another user's row (the target state)" '"is_head":true' "$(hadm "select is_head from public.user_roles where user_id = '$H2' and role = 'admin';")"
    expect "the access token hook still sets the claim: admin" '"user_role":"admin"' "$(echo "select public.custom_access_token_hook(jsonb_build_object('user_id','$H','claims','{}'::jsonb)) -> 'claims' as c;" | run)"
    expect "the access token hook still sets the claim: user" '"user_role":"user"' "$(echo "select public.custom_access_token_hook(jsonb_build_object('user_id','$U','claims','{}'::jsonb)) -> 'claims' as c;" | run)";;
cleanup) run <<SQL
delete from public.admin_audit_log where admin_id in ($IDS) or target_user_id in ($IDS);
delete from auth.users where id in ($IDS);
select (select count(*) from public.profiles where id in ($IDS)) profiles,
       (select count(*) from public.user_roles where user_id in ($IDS)) roles,
       (select count(*) from public.user_roles where user_id in ($IDS) and is_head) test_heads,
       (select count(*) from public.admin_audit_log where admin_id in ($IDS) or target_user_id in ($IDS)) audit_rows;
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
  echo "== cleanup (deletes the test users, their roles and audit rows)"
  expect "no test user, role, head admin or audit row left" '"profiles":0,"roles":0,"test_heads":0,"audit_rows":0' "$(step cleanup)"
}
trap restore EXIT
trap 'restore; exit 130' INT
trap 'restore; exit 143' TERM
trap 'restore; exit 1' ERR

steps=("$@"); [ ${#steps[@]} -eq 0 ] && steps=(t1 t2 t3 t4 t5 t6 t7)
step setup
for s in "${steps[@]}"; do step "$s"; echo; done
restore
echo "== $FAILS check(s) failed"
exit $FAILS
