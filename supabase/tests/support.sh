#!/bin/bash
# Support tickets tests. Prints PASS/FAIL lines (no keys) and exits non-zero if any check fails.
# Usage: supabase/tests/support.sh [t1 ... t5]  (Management API, write token required)
# Always runs setup, the given steps (all by default), then cleanup, in one process. A trap on
# EXIT, INT, TERM and ERR runs cleanup, which deletes the test users (their tickets, messages
# and notifications cascade).
# The project comes from SUPABASE_PROJECT_REF; abort before any query unless it matches the
# ref in NEXT_PUBLIC_SUPABASE_URL.
REF=${SUPABASE_PROJECT_REF:?SUPABASE_PROJECT_REF is not set}
URL_REF=$(printf '%s' "${NEXT_PUBLIC_SUPABASE_URL:-}" | sed -nE 's#^https://([a-z0-9]+)\.supabase\.co/?$#\1#p')
if [ "$REF" != "$URL_REF" ]; then echo "SUPABASE_PROJECT_REF does not match NEXT_PUBLIC_SUPABASE_URL; aborting." >&2; exit 1; fi
A=aaaaaaaa-0000-4000-8000-0000000000aa   # ticket owner
B=bbbbbbbb-0000-4000-8000-0000000000bb   # admin
C=cccccccc-0000-4000-8000-0000000000cc   # another user (never an admin row)
FAILS=0
run() { jq -Rs '{query: ., read_only: false}' | curl -sS -X POST "https://api.supabase.com/v1/projects/$REF/database/query" -H 'Content-Type: application/json' --data-binary @-; echo; }
# as <uid> <user_role> <sql>
as() { run <<SQL
begin;
select set_config('request.jwt.claims', json_build_object('sub','$1','role','authenticated','aal','aal1','user_role','$2')::text, true);
set local role authenticated;
$3
commit;
SQL
}
user() { as "$1" user "$2"; }
adm() { as $B admin "$1"; }
# expect <label> <extended regex> <output>
expect() { if printf '%s' "$3" | grep -Eq "$2"; then echo "PASS $1"; else echo "FAIL $1 (expected /$2/): $3"; FAILS=$((FAILS+1)); fi; }
key() { printf '99999999-0000-4000-8000-%012d' "$1"; }
ticket() { echo "select id from public.support_tickets where client_request_id = '$(key 1)';" | run | jq -r '.[0].id'; }
status() { echo "select status from public.support_tickets where client_request_id = '$(key 1)';" | run; }

step() {
case "$1" in
setup) run <<SQL
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000','$A','authenticated','authenticated','support-test-a@aureonx.invalid','',now(),'{}','{"nickname":"TestA"}',now(),now()),
       ('00000000-0000-0000-0000-000000000000','$B','authenticated','authenticated','support-test-b@aureonx.invalid','',now(),'{}','{"nickname":"TestB"}',now(),now()),
       ('00000000-0000-0000-0000-000000000000','$C','authenticated','authenticated','support-test-c@aureonx.invalid','',now(),'{}','{"nickname":"TestC"}',now(),now());
insert into public.user_roles (user_id, role) values ('$B','admin');
select count(*) profiles from public.profiles where id in ('$A','$B','$C');
SQL
;;
t1) echo "T1 support_create_ticket: validation, trimming, replay"
    K=$(key 1); LONG=$(printf 'x%.0s' $(seq 1 121)); BODY=$(printf 'y%.0s' $(seq 1 2001))
    expect "unknown topic -> SUPPORT_INVALID_TOPIC" SUPPORT_INVALID_TOPIC "$(user $A "select public.support_create_ticket('billing', 'Hi', 'Body', '$K');")"
    expect "no topic -> SUPPORT_INVALID_TOPIC" SUPPORT_INVALID_TOPIC "$(user $A "select public.support_create_ticket(null, 'Hi', 'Body', '$K');")"
    expect "blank subject -> SUPPORT_INVALID_SUBJECT" SUPPORT_INVALID_SUBJECT "$(user $A "select public.support_create_ticket('account', E'  \\n ', 'Body', '$K');")"
    expect "subject of 121 -> SUPPORT_INVALID_SUBJECT" SUPPORT_INVALID_SUBJECT "$(user $A "select public.support_create_ticket('account', '$LONG', 'Body', '$K');")"
    expect "blank body -> SUPPORT_INVALID_BODY" SUPPORT_INVALID_BODY "$(user $A "select public.support_create_ticket('account', 'Hi', E'\\n\\t ', '$K');")"
    expect "body of 2001 -> SUPPORT_INVALID_BODY" SUPPORT_INVALID_BODY "$(user $A "select public.support_create_ticket('account', 'Hi', '$BODY', '$K');")"
    expect "nothing written" '"n":0' "$(echo "select count(*) n from public.support_tickets where user_id = '$A';" | run)"
    expect "created open, subject trimmed" '"status":"open","subject":"Cannot see my balance"' "$(user $A "select (t).status, (t).subject from (select public.support_create_ticket('balance_funding', '  Cannot see my balance ', E'My balance shows zero.\\n', '$K') t) x;")"
    expect "first message trimmed, not staff" '"is_staff":false,"body":"My balance shows zero."' "$(echo "select is_staff, body from public.support_messages where client_request_id = '$K';" | run)"
    user $A "select public.support_create_ticket('balance_funding', 'Cannot see my balance', 'My balance shows zero.', '$K');" > /dev/null
    expect "same key twice: one ticket" '"n":1' "$(echo "select count(*) n from public.support_tickets where user_id = '$A';" | run)"
    expect "same key, other subject -> IDEMPOTENCY_CONFLICT" IDEMPOTENCY_CONFLICT "$(user $A "select public.support_create_ticket('balance_funding', 'Other', 'My balance shows zero.', '$K');")"
    expect "same key, other body -> IDEMPOTENCY_CONFLICT" IDEMPOTENCY_CONFLICT "$(user $A "select public.support_create_ticket('balance_funding', 'Cannot see my balance', 'Other', '$K');")";;
t2) echo "T2 reads under RLS and no client writes"
    T=$(ticket)
    expect "owner reads the ticket" '"n":1' "$(user $A "select count(*) n from public.support_tickets where id = '$T';")"
    expect "owner reads its messages" '"n":1' "$(user $A "select count(*) n from public.support_messages where ticket_id = '$T';")"
    expect "another user reads no ticket" '"n":0' "$(user $C "select count(*) n from public.support_tickets where id = '$T';")"
    expect "another user reads no message" '"n":0' "$(user $C "select count(*) n from public.support_messages where ticket_id = '$T';")"
    expect "admin reads the ticket and messages" '"t":1,"m":1' "$(adm "select (select count(*) from public.support_tickets where id = '$T') t, (select count(*) from public.support_messages where ticket_id = '$T') m;")"
    expect "author_id is not readable by the owner" 'permission denied' "$(user $A "select author_id from public.support_messages where ticket_id = '$T';")"
    expect "author_id is not readable by an admin either" 'permission denied' "$(adm "select author_id from public.support_messages where ticket_id = '$T';")"
    expect "no direct ticket insert" 'permission denied' "$(user $A "insert into public.support_tickets (user_id, topic, subject, client_request_id) values ('$A', 'other', 'x', gen_random_uuid());")"
    expect "no direct message insert" 'permission denied' "$(user $A "insert into public.support_messages (ticket_id, is_staff, body, client_request_id) values ('$T', true, 'x', gen_random_uuid());")"
    expect "no direct status update by an admin" 'permission denied' "$(adm "update public.support_tickets set status = 'closed' where id = '$T';")";;
t3) echo "T3 support_reply: is_staff and status set by the server, notification on a staff reply"
    T=$(ticket)
    expect "another user -> SUPPORT_NOT_FOUND" SUPPORT_NOT_FOUND "$(user $C "select public.support_reply('$T', 'hello', gen_random_uuid());")"
    expect "admin claim without an admin row -> SUPPORT_NOT_FOUND" SUPPORT_NOT_FOUND "$(as $C admin "select public.support_reply('$T', 'hello', gen_random_uuid());")"
    expect "admin row without the admin claim -> SUPPORT_NOT_FOUND" SUPPORT_NOT_FOUND "$(as $B user "select public.support_reply('$T', 'hello', gen_random_uuid());")"
    expect "unknown ticket -> SUPPORT_NOT_FOUND" SUPPORT_NOT_FOUND "$(adm "select public.support_reply(gen_random_uuid(), 'hello', gen_random_uuid());")"
    expect "blank reply -> SUPPORT_INVALID_BODY" SUPPORT_INVALID_BODY "$(adm "select public.support_reply('$T', '  ', gen_random_uuid());")"
    expect "staff reply is_staff true" '"is_staff":true' "$(adm "select (public.support_reply('$T', 'We are checking.', '$(key 31)')).is_staff;")"
    expect "status answered" '"status":"answered"' "$(status)"
    expect "one notification for the owner" '"n":1,"k":"support_reply"' "$(echo "select count(*) n, min(kind) k from public.notifications where user_id = '$A' and ticket_id = '$T';" | run)"
    adm "select public.support_reply('$T', 'We are checking.', '$(key 31)');" > /dev/null
    expect "same key twice: one staff message, one notification" '"m":1,"n":1' "$(echo "select (select count(*) from public.support_messages where client_request_id = '$(key 31)') m, (select count(*) from public.notifications where ticket_id = '$T') n;" | run)"
    expect "owner reply is_staff false" '"is_staff":false' "$(user $A "select (public.support_reply('$T', 'Thanks.', '$(key 32)')).is_staff;")"
    expect "status open again" '"status":"open"' "$(status)"
    expect "no notification for a user reply" '"n":1' "$(echo "select count(*) n from public.notifications where ticket_id = '$T';" | run)";;
t4) echo "T4 closing: admin only, then no replies"
    T=$(ticket)
    expect "owner cannot close -> FORBIDDEN" FORBIDDEN "$(user $A "select public.admin_support_close('$T');")"
    expect "admin claim without an admin row -> FORBIDDEN" FORBIDDEN "$(as $C admin "select public.admin_support_close('$T');")"
    expect "admin closes" '"status":"closed"' "$(adm "select (public.admin_support_close('$T')).status;")"
    expect "closing again returns it closed" '"status":"closed"' "$(adm "select (public.admin_support_close('$T')).status;")"
    expect "owner reply -> SUPPORT_CLOSED" SUPPORT_CLOSED "$(user $A "select public.support_reply('$T', 'one more', gen_random_uuid());")"
    expect "staff reply -> SUPPORT_CLOSED" SUPPORT_CLOSED "$(adm "select public.support_reply('$T', 'one more', gen_random_uuid());")"
    expect "still closed" '"status":"closed"' "$(status)";;
t5) echo "T5 notifications: own rows only, mark read"
    N=$(echo "select id from public.notifications where user_id = '$A' limit 1;" | run | jq -r '.[0].id')
    expect "owner reads it unread" '"read":false' "$(user $A "select read_at is not null as read from public.notifications where id = '$N';")"
    expect "another user reads none" '"n":0' "$(user $C "select count(*) n from public.notifications where id = '$N';")"
    expect "an admin reads none of another user's" '"n":0' "$(adm "select count(*) n from public.notifications where id = '$N';")"
    expect "another user cannot mark it" '"mark_notifications_read":0' "$(user $C "select public.mark_notifications_read(array['$N']::uuid[]);")"
    expect "owner marks it" '"mark_notifications_read":1' "$(user $A "select public.mark_notifications_read(array['$N']::uuid[]);")"
    expect "marking again changes nothing" '"mark_notifications_read":0' "$(user $A "select public.mark_notifications_read(array['$N']::uuid[]);")"
    expect "no direct update" 'permission denied' "$(user $A "update public.notifications set read_at = null where id = '$N';")";;
cleanup) run <<SQL
delete from auth.users where id in ('$A','$B','$C');
select (select count(*) from public.profiles where id in ('$A','$B','$C')) profiles,
       (select count(*) from public.support_tickets where user_id in ('$A','$B','$C')) tickets,
       (select count(*) from public.support_messages where client_request_id::text like '99999999-%') messages,
       (select count(*) from public.notifications where user_id in ('$A','$B','$C')) notifications;
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
  echo "== cleanup"; step cleanup
}
trap restore EXIT
trap 'restore; exit 130' INT
trap 'restore; exit 143' TERM
trap 'restore; exit 1' ERR

steps=("$@"); [ ${#steps[@]} -eq 0 ] && steps=(t1 t2 t3 t4 t5)
step setup
for s in "${steps[@]}"; do step "$s"; echo; done
echo "== $FAILS check(s) failed"
exit $FAILS
