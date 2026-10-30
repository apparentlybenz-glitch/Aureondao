#!/bin/bash
# Slice 8 tests (KYC, the kyc-photos bucket, kyc-cleanup). Prints PASS/FAIL lines (no keys or
# tokens) and exits non-zero if any check fails.
# Usage: supabase/tests/slice8.sh [t1 ... t9]  (Management API, write token required)
# Always runs setup, the given steps (all by default), then cleanup, in one process. A trap on
# EXIT, INT, TERM and ERR runs cleanup, which deletes the test files (Storage API), the test
# users and their audit rows.
# Storage enforces its policies and limits only on real requests, so the test users are created
# through the Auth admin API and sign in with a password; the admin enrolls a TOTP factor to
# reach aal2. The secret key is read from the Management API into a variable and never printed.
# RPC checks run as SQL with request.jwt.claims set, as in slice7.sh.
# The project comes from SUPABASE_PROJECT_REF; abort before any query unless it matches the
# ref in NEXT_PUBLIC_SUPABASE_URL.
REF=${SUPABASE_PROJECT_REF:?SUPABASE_PROJECT_REF is not set}
URL=${NEXT_PUBLIC_SUPABASE_URL%/}
URL_REF=$(printf '%s' "$URL" | sed -nE 's#^https://([a-z0-9]+)\.supabase\.co$#\1#p')
if [ "$REF" != "$URL_REF" ]; then echo "SUPABASE_PROJECT_REF does not match NEXT_PUBLIC_SUPABASE_URL; aborting." >&2; exit 1; fi
PK=${NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:?NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is not set}
SK=$(curl -sS "https://api.supabase.com/v1/projects/$REF/api-keys?reveal=true" | jq -r '.[] | select(.type == "secret") | .api_key' | head -n1)
[ -n "$SK" ] || { echo "could not read the secret key; aborting." >&2; exit 1; }

A=aaaaaaaa-0000-4000-8000-00000000008a   # user who submits
B=bbbbbbbb-0000-4000-8000-00000000008b   # admin
C=cccccccc-0000-4000-8000-00000000008c   # plain user (never an admin)
D=dddddddd-0000-4000-8000-00000000008d   # user deleted by the cleanup test
ALL="'$A','$B','$C','$D'"
PW="T8-$(openssl rand -hex 12)"
TMP=$(mktemp -d)
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
expect() { if printf '%s' "$3" | grep -Eq "$2"; then echo "PASS $1"; else echo "FAIL $1 (expected /$2/): ${3:0:400}"; FAILS=$((FAILS+1)); fi; }
key() { printf '88888888-0000-4000-8000-%012d' "$1"; }

# Auth and Storage over HTTP. The secret key goes only in the apikey header.
admin_api() { curl -sS -X "$1" "$URL/auth/v1/admin/$2" -H "apikey: $SK" -H 'Content-Type: application/json' ${3:+--data-binary "$3"}; }
signin() { curl -sS -X POST "$URL/auth/v1/token?grant_type=password" -H "apikey: $PK" -H 'Content-Type: application/json' \
  --data-binary "$(jq -n --arg e "$1" --arg p "$PW" '{email: $e, password: $p}')" | jq -r '.access_token // empty'; }
# upload <token> <path> <file> <content type>: prints the HTTP status, then the body.
upload() { curl -sS -o "$TMP/out" -w '%{http_code}' -X POST "$URL/storage/v1/object/kyc-photos/$2" -H "apikey: $PK" \
  -H "Authorization: Bearer $1" -H "Content-Type: $4" --data-binary "@$3"; printf ' '; head -c 300 "$TMP/out"; }
download() { curl -sS -o "$TMP/dl" -w '%{http_code}' "$URL/storage/v1/object/authenticated/kyc-photos/$2" -H "apikey: $PK" -H "Authorization: Bearer $1"; }
sign() { curl -sS -X POST "$URL/storage/v1/object/sign/kyc-photos/$2" -H "apikey: $PK" -H "Authorization: Bearer $1" \
  -H 'Content-Type: application/json' -d '{"expiresIn":60}'; }
totp() { node -e '
const s = process.argv[1].replace(/=+$/, "");
const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const bits = [...s].map((ch) => a.indexOf(ch).toString(2).padStart(5, "0")).join("");
const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
const t = Buffer.alloc(8); t.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
const h = require("crypto").createHmac("sha1", key).update(t).digest();
const o = h[19] & 15;
console.log(String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, "0"));' "$1"; }

# submit <uid> <key> <path> [country] [name] [dob sql] [city]
submit() { user "$1" "select (s).status, (s).id from (select public.submit_kyc('${4:-DE}', 'passport', '${5:-Test Person}',
  ${6:-date '1990-05-01'}, '${7:-Berlin}', '$3', '$2') s) x;"; }
review() { adm "select (r).status from (select public.admin_review_kyc('$1', $2, '$3') r) x;"; }
sub_id() { echo "select id from public.kyc_submissions where client_request_id = '$1';" | run | jq -r '.[0].id'; }
# Files in the test users' folders, by path.
test_files() { echo "select coalesce(json_agg(name order by name), '[]') f from storage.objects where bucket_id = 'kyc-photos'
  and (storage.foldername(name))[1] in ($ALL);" | run | jq -c '.[0].f'; }

step() {
case "$1" in
setup)
    # A 1x1 PNG, a 6 MB file and a PDF header.
    printf '%s' 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' | base64 -d > "$TMP/a.png"
    head -c 6291456 /dev/zero > "$TMP/big.jpg"
    printf '%%PDF-1.4\n%%%%EOF\n' > "$TMP/doc.pdf"
    for u in "$A:a" "$B:b" "$C:c" "$D:d"; do
      admin_api POST users "$(jq -n --arg id "${u%%:*}" --arg e "slice8-test-${u##*:}@aureonx.invalid" --arg p "$PW" \
        '{id: $id, email: $e, password: $p, email_confirm: true, user_metadata: {nickname: "Slice8"}}')" > /dev/null
    done
    echo "insert into public.user_roles (user_id, role) values ('$B','admin');" | run > /dev/null
    TA=$(signin slice8-test-a@aureonx.invalid); TC=$(signin slice8-test-c@aureonx.invalid); TD=$(signin slice8-test-d@aureonx.invalid)
    TB1=$(signin slice8-test-b@aureonx.invalid)
    F=$(curl -sS -X POST "$URL/auth/v1/factors" -H "apikey: $PK" -H "Authorization: Bearer $TB1" -H 'Content-Type: application/json' -d '{"factor_type":"totp"}')
    FID=$(printf '%s' "$F" | jq -r .id); FSECRET=$(printf '%s' "$F" | jq -r .totp.secret)
    # Auth refuses a verify from another IP than its challenge (mfa_ip_address_mismatch), and
    # the outbound proxy can change IP between requests: retry the pair a few times.
    TB=""
    for _ in 1 2 3 4 5 6 7 8; do
      CH=$(curl -sS -X POST "$URL/auth/v1/factors/$FID/challenge" -H "apikey: $PK" -H "Authorization: Bearer $TB1" | jq -r .id)
      TB=$(curl -sS -X POST "$URL/auth/v1/factors/$FID/verify" -H "apikey: $PK" -H "Authorization: Bearer $TB1" -H 'Content-Type: application/json' \
        --data-binary "$(jq -n --arg c "$CH" --arg code "$(totp "$FSECRET")" '{challenge_id: $c, code: $code}')" | jq -r '.access_token // empty')
      [ -n "$TB" ] && break
    done
    unset FSECRET
    aal() { local p; p=$(printf '%s' "$1" | cut -d. -f2 | tr '_-' '/+'); while [ $(( ${#p} % 4 )) -ne 0 ]; do p="$p="; done
      printf '%s' "$p" | base64 -d 2>/dev/null | jq -r '"\(.aal) \(.user_role)"' 2>/dev/null || true; }
    expect "setup: four users with tokens, the admin at aal2" '^aal1 user aal1 user aal1 user aal1 admin aal2 admin$' \
      "$(echo $(aal "$TA") $(aal "$TC") $(aal "$TD") $(aal "$TB1") $(aal "$TB"))";;
t1) echo "T1 upload: own folder succeeds, another user's folder fails"
    expect "A uploads to A/" '^200 ' "$(upload "$TA" "$A/$(key 1).png" "$TMP/a.png" image/png)"
    expect "A uploads to C/ -> refused" '^(400|403) .*(row-level security|Unauthorized)' "$(upload "$TA" "$C/$(key 2).png" "$TMP/a.png" image/png)"
    expect "A uploads to the bucket root -> refused" '^(400|403) ' "$(upload "$TA" "$(key 3).png" "$TMP/a.png" image/png)"
    expect "A cannot overwrite (no upsert, no update policy)" '^(400|409) .*(Duplicate|exists)' "$(upload "$TA" "$A/$(key 1).png" "$TMP/a.png" image/png)"
    expect "only A's file exists" "^\[\"$A/$(key 1).png\"\]$" "$(test_files)";;
t2) echo "T2 read: own file yes, another user's file no, client delete no"
    expect "A reads own file" '^200$' "$(download "$TA" "$A/$(key 1).png")"
    expect "C reads A's file -> not found" '^(400|404)$' "$(download "$TC" "$A/$(key 1).png")"
    expect "C cannot sign A's file" '"e":"(not_found|.*not found)' "$(sign "$TC" "$A/$(key 1).png" | jq -c '{e: (.error // .message)}')"
    expect "A cannot delete own file through the API" "\"$A/$(key 1).png\"" "$(curl -sS -X DELETE "$URL/storage/v1/object/kyc-photos" -H "apikey: $PK" -H "Authorization: Bearer $TA" \
      -H 'Content-Type: application/json' -d "{\"prefixes\":[\"$A/$(key 1).png\"]}" > /dev/null; test_files)";;
t3) echo "T3 bucket limits: a 6 MB file and a PDF are refused"
    expect "6 MB JPEG -> too large" '^(400|413) .*(too large|exceeded the maximum|Payload)' "$(upload "$TA" "$A/$(key 31).jpg" "$TMP/big.jpg" image/jpeg)"
    expect "PDF -> type not allowed" '^(400|415) .*(mime type|not supported)' "$(upload "$TA" "$A/$(key 32).pdf" "$TMP/doc.pdf" application/pdf)"
    expect "neither was stored" "^\[\"$A/$(key 1).png\"\]$" "$(test_files)";;
t4) echo "T4 submit_kyc: field checks, path checks, idempotency"
    P="$A/$(key 1).png"
    expect "path in another user's folder -> KYC_PATH_INVALID" KYC_PATH_INVALID "$(submit $A "$(key 41)" "$C/$(key 2).png")"
    expect "path with .. -> KYC_PATH_INVALID" KYC_PATH_INVALID "$(submit $A "$(key 41)" "$A/../$C/x.png")"
    expect "missing file in own folder -> KYC_FILE_MISSING" KYC_FILE_MISSING "$(submit $A "$(key 41)" "$A/nope.png")"
    expect "unknown country -> KYC_INVALID_COUNTRY" KYC_INVALID_COUNTRY "$(submit $A "$(key 41)" "$P" XX)"
    expect "1-character name -> KYC_INVALID_NAME" KYC_INVALID_NAME "$(submit $A "$(key 41)" "$P" DE 'J')"
    expect "17 years old -> KYC_INVALID_DOB" KYC_INVALID_DOB "$(submit $A "$(key 41)" "$P" DE 'Test Person' "(current_date - interval '17 years')::date")"
    expect "born 1900-01-01 -> KYC_INVALID_DOB" KYC_INVALID_DOB "$(submit $A "$(key 41)" "$P" DE 'Test Person' "date '1900-01-01'")"
    expect "blank city -> KYC_INVALID_CITY" KYC_INVALID_CITY "$(submit $A "$(key 41)" "$P" DE 'Test Person' "date '1990-05-01'" ' ')"
    expect "no key -> INVALID_ARGUMENT" INVALID_ARGUMENT "$(user $A "select public.submit_kyc('DE','passport','Test Person',date '1990-05-01','Berlin','$P',null);")"
    expect "valid submission is pending (lowercase country accepted)" '"status":"pending"' "$(submit $A "$(key 41)" "$P" de)"
    expect "same key again returns it: one row" '"n":1' "$(submit $A "$(key 41)" "$P" de > /dev/null; echo "select count(*) n from public.kyc_submissions where user_id = '$A';" | run)"
    expect "same key, other values -> IDEMPOTENCY_CONFLICT" IDEMPOTENCY_CONFLICT "$(submit $A "$(key 41)" "$P" FR)"
    expect "stored trimmed and upper-cased" '"country":"DE","full_name":"Test Person","city":"Berlin"' "$(echo "select country, full_name, city from public.kyc_submissions where client_request_id = '$(key 41)';" | run)";;
t5) echo "T5 one pending submission per user; no client writes"
    expect "second submission while pending -> KYC_PENDING" KYC_PENDING "$(submit $A "$(key 51)" "$A/$(key 1).png")"
    expect "the unique index refuses a second pending row too" 'kyc_one_pending_idx' "$(echo "insert into public.kyc_submissions (user_id, country, document_type, full_name, date_of_birth, city, photo_path, client_request_id)
      values ('$A','DE','passport','Test Person','1990-05-01','Berlin','$A/$(key 1).png','$(key 52)');" | run)"
    expect "client insert -> permission denied" 'permission denied' "$(user $A "insert into public.kyc_submissions (user_id, country, document_type, full_name, date_of_birth, city, photo_path, client_request_id)
      values ('$A','DE','passport','Test Person','1990-05-01','Berlin','$A/$(key 1).png','$(key 53)');")"
    expect "client update -> permission denied" 'permission denied' "$(user $A "update public.kyc_submissions set status = 'approved' where user_id = '$A';")"
    expect "client delete -> permission denied" 'permission denied' "$(user $A "delete from public.kyc_submissions where user_id = '$A';")"
    expect "kyc_current shows A pending" '"status":"pending"' "$(user $A "select status from public.kyc_current where user_id = '$A';")"
    expect "C has no state (not started)" '"count":0' "$(user $C "select count(*) from public.kyc_current;")";;
t6) echo "T6 admin_review_kyc: FORBIDDEN, argument checks, reject with an audit row"
    S=$(sub_id "$(key 41)"); K=$(key 61)
    expect "plain user at aal2 -> FORBIDDEN" FORBIDDEN "$(as $C aal2 user "select public.admin_review_kyc('$S', true, '$K');")"
    expect "plain user at aal1 -> FORBIDDEN" FORBIDDEN "$(as $C aal1 user "select public.admin_review_kyc('$S', true, '$K');")"
    expect "admin claim without an admin row at aal1 -> FORBIDDEN" FORBIDDEN "$(as $C aal1 admin "select public.admin_review_kyc('$S', true, '$K');")"
    expect "admin at aal1 passes the gate (unknown submission -> KYC_NOT_FOUND)" KYC_NOT_FOUND "$(as $B aal1 admin "select public.admin_review_kyc('00000000-0000-4000-8000-000000000001', true, '$K');")"
    expect "admin claim without an admin row -> FORBIDDEN" FORBIDDEN "$(as $C aal2 admin "select public.admin_review_kyc('$S', true, '$K');")"
    expect "old signature with a reason is gone, new one exists, no reason column" '"old":0,"new":1,"col":0,"view_col":0,"invoker":true' "$(echo "select count(to_regprocedure('public.admin_review_kyc(uuid, boolean, text, uuid)')) old, count(to_regprocedure('public.admin_review_kyc(uuid, boolean, uuid)')) new,
      (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'kyc_submissions' and column_name = 'rejection_reason') col,
      (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'kyc_current' and column_name = 'rejection_reason') view_col,
      (select 'security_invoker=true' = any (reloptions) from pg_class where oid = 'public.kyc_current'::regclass) invoker;" | run)"
    expect "unknown submission -> KYC_NOT_FOUND" KYC_NOT_FOUND "$(review "00000000-0000-4000-8000-000000000001" true "$K")"
    expect "nothing changed, no audit row" '"status":"pending","a":0' "$(echo "select status, (select count(*) from public.admin_audit_log where client_request_id = '$K') a from public.kyc_submissions where id = '$S';" | run)"
    expect "reject with no reason" '"status":"rejected"' "$(review "$S" false "$K")"
    expect "audit row kyc_reject with the target, empty payload, no reason key" "\"action\":\"kyc_reject\",\"target_user_id\":\"$A\",\"target_id\":\"$S\",\"e\":true,\"r\":false" \
      "$(echo "select action, target_user_id, target_id, payload = '{}'::jsonb e, payload ? 'reason' r from public.admin_audit_log where client_request_id = '$K';" | run)"
    expect "same key again returns the row: one audit row" '"n":1' "$(review "$S" false "$K" > /dev/null; echo "select count(*) n from public.admin_audit_log where client_request_id = '$K';" | run)"
    expect "same key, approve -> IDEMPOTENCY_CONFLICT" IDEMPOTENCY_CONFLICT "$(review "$S" true "$K")"
    expect "a new key on a decided submission -> KYC_NOT_PENDING" KYC_NOT_PENDING "$(review "$S" true "$(key 62)")"
    expect "decided_at and decided_by set" "\"d\":true,\"decided_by\":\"$B\"" "$(echo "select decided_at is not null d, decided_by from public.kyc_submissions where id = '$S';" | run)"
    expect "A reads the rejected status" '"status":"rejected"' "$(user $A "select status from public.kyc_current;")";;
t7) echo "T7 resubmit after a rejection, approve, then Update after approval"
    expect "A uploads a new photo" '^200 ' "$(upload "$TA" "$A/$(key 71).png" "$TMP/a.png" image/png)"
    expect "resubmit after rejection is pending" '"status":"pending"' "$(submit $A "$(key 71)" "$A/$(key 71).png" DE 'Test Person Two')"
    S=$(sub_id "$(key 71)")
    expect "approve" '"status":"approved"' "$(review "$S" true "$(key 72)")"
    expect "audit row kyc_approve, empty payload, no reason key" '"action":"kyc_approve","e":true,"r":false' "$(echo "select action, payload = '{}'::jsonb e, payload ? 'reason' r from public.admin_audit_log where client_request_id = '$(key 72)';" | run)"
    expect "kyc_current shows approved" '"status":"approved","full_name":"Test Person Two"' "$(user $A "select status, full_name from public.kyc_current;")"
    expect "A uploads for an update" '^200 ' "$(upload "$TA" "$A/$(key 73).png" "$TMP/a.png" image/png)"
    expect "Update after approval returns to pending" '"status":"pending"' "$(submit $A "$(key 73)" "$A/$(key 73).png" FR 'Test Person Three' "date '1985-02-03'" Paris)"
    expect "kyc_current shows the newest one" '"status":"pending","country":"FR"' "$(user $A "select status, country from public.kyc_current;")"
    expect "three submissions kept" '"n":3' "$(echo "select count(*) n from public.kyc_submissions where user_id = '$A';" | run)";;
t8) echo "T8 signed URLs: an admin (aal1 or aal2) can read any photo; a non-admin cannot read others' submissions"
    P="$A/$(key 1).png"
    SU=$(sign "$TB" "$P" | jq -r '.signedURL // empty')
    expect "admin at aal2 gets a signed URL" 'token=' "${SU:+token=}"
    expect "the signed URL serves the file" '^200 same$' "$(curl -sS -o "$TMP/signed" -w '%{http_code}' "$URL/storage/v1$SU"; cmp -s "$TMP/signed" "$TMP/a.png" && echo ' same')"
    expect "admin at aal1 gets a signed URL too" 'token=' "$(sign "$TB1" "$P" | jq -r '.signedURL // empty' | sed 's/.*\(token=\).*/\1/')"
    expect "a plain user cannot sign it" '"e":"(not_found|.*not found)' "$(sign "$TC" "$P" | jq -c '{e: (.error // .message)}')"
    expect "C reads none of A's submissions" '"count":0' "$(user $C "select count(*) from public.kyc_submissions where user_id = '$A';")"
    expect "C reads none of A's state" '"count":0' "$(user $C "select count(*) from public.kyc_current where user_id = '$A';")"
    expect "admin at aal1 reads A's submissions" '"count":3' "$(as $B aal1 admin "select count(*) from public.kyc_submissions where user_id = '$A';")"
    expect "admin at aal2 reads A's submissions" '"count":3' "$(adm "select count(*) from public.kyc_submissions where user_id = '$A';")";;
t10) echo "T10 admin_log_kyc_photo_view: one audit row per detail open; refused calls write nothing"
    S=$(echo "select id from public.kyc_submissions where user_id = '$A' order by submitted_at limit 1;" | run | jq -r '.[0].id')
    views() { echo "select count(*) n from public.admin_audit_log where action = 'kyc_photo_view' and target_id = '$S';" | run; }
    expect "plain user at aal2 -> FORBIDDEN" FORBIDDEN "$(as $C aal2 user "select public.admin_log_kyc_photo_view('$S');")"
    expect "plain user at aal1 -> FORBIDDEN" FORBIDDEN "$(as $C aal1 user "select public.admin_log_kyc_photo_view('$S');")"
    expect "admin claim without an admin row at aal1 -> FORBIDDEN" FORBIDDEN "$(as $C aal1 admin "select public.admin_log_kyc_photo_view('$S');")"
    expect "admin at aal1 passes the gate (unknown submission -> KYC_NOT_FOUND)" KYC_NOT_FOUND "$(as $B aal1 admin "select public.admin_log_kyc_photo_view('00000000-0000-4000-8000-000000000001');")"
    expect "admin claim without an admin row -> FORBIDDEN" FORBIDDEN "$(as $C aal2 admin "select public.admin_log_kyc_photo_view('$S');")"
    expect "unknown submission -> KYC_NOT_FOUND" KYC_NOT_FOUND "$(adm "select public.admin_log_kyc_photo_view('00000000-0000-4000-8000-000000000001');")"
    expect "refused calls wrote nothing" '"n":0' "$(views)"
    adm "select public.admin_log_kyc_photo_view('$S');" > /dev/null
    expect "one detail open writes exactly one row" '"n":1' "$(views)"
    expect "the row names the admin, the user, the submission and one photo" "\"admin_id\":\"$B\",\"target_user_id\":\"$A\",\"photos\":\"1\"" \
      "$(echo "select admin_id, target_user_id, payload ->> 'photos' photos from public.admin_audit_log where action = 'kyc_photo_view' and target_id = '$S';" | run)";;
t9) echo "T9 kyc-cleanup removes a deleted user's files and leaves other folders alone"
    expect "D uploads" '^200 ' "$(upload "$TD" "$D/$(key 91).png" "$TMP/a.png" image/png)"
    expect "D submits" '"status":"pending"' "$(submit $D "$(key 91)" "$D/$(key 91).png")"
    BEFORE_A=$(echo "select count(*) n from storage.objects where bucket_id = 'kyc-photos' and name like '$A/%';" | run | jq -r '.[0].n')
    admin_api DELETE "users/$D" > /dev/null
    expect "D deleted: submissions cascade, files stay until the job runs" '"u":0,"s":0,"f":1' "$(echo "select (select count(*) from auth.users where id = '$D') u,
      (select count(*) from public.kyc_submissions where user_id = '$D') s, (select count(*) from storage.objects where bucket_id = 'kyc-photos' and name like '$D/%') f;" | run)"
    LAST=$(echo "select coalesce(max(id), 0) id from net._http_response;" | run | jq -r '.[0].id')
    echo "select private.kyc_cleanup_tick();" | run > /dev/null
    R=""; for _ in 1 2 3 4 5 6 7 8 9 10; do sleep 2
      R=$(echo "select status_code, content::text c from net._http_response where id > $LAST and content::text like '%orphans%' order by id limit 1;" | run)
      printf '%s' "$R" | grep -q status_code && break; done
    expect "the job answered 200 and removed D's file" '"status_code":200.*\\"orphans\\":[1-9][0-9]*,\\"removed\\":[1-9]' "$R"
    expect "D's folder is empty" '"n":0' "$(echo "select count(*) n from storage.objects where bucket_id = 'kyc-photos' and name like '$D/%';" | run)"
    expect "A's files are untouched" "\"n\":$BEFORE_A" "$(echo "select count(*) n from storage.objects where bucket_id = 'kyc-photos' and name like '$A/%';" | run)";;
cleanup)
    PATHS=$(echo "select coalesce(json_agg(name), '[]') p from storage.objects where bucket_id = 'kyc-photos' and (storage.foldername(name))[1] in ($ALL);" | run | jq -c '.[0].p')
    if [ "$PATHS" != "[]" ] && [ -n "$PATHS" ]; then
      curl -sS -X DELETE "$URL/storage/v1/object/kyc-photos" -H "apikey: $SK" -H 'Content-Type: application/json' \
        --data-binary "$(jq -n --argjson p "$PATHS" '{prefixes: $p}')" > /dev/null
    fi
    # Audit rows first: deleting a user sets their audit ids to null.
    echo "delete from public.admin_audit_log where admin_id in ($ALL) or target_user_id in ($ALL)
      or client_request_id::text like '88888888-0000-4000-8000-%';" | run > /dev/null
    for u in $A $B $C $D; do admin_api DELETE "users/$u" > /dev/null; done
    rm -rf "$TMP"
    run <<SQL
delete from auth.users where id in ($ALL);
select (select count(*) from auth.users where id in ($ALL)) users,
       (select count(*) from public.profiles where id in ($ALL)) profiles,
       (select count(*) from public.kyc_submissions where user_id in ($ALL)) submissions,
       (select count(*) from storage.objects where bucket_id = 'kyc-photos' and (storage.foldername(name))[1] in ($ALL)) files,
       (select count(*) from public.admin_audit_log where client_request_id::text like '88888888-0000-4000-8000-%') audit_rows,
       (select count(*) from public.admin_audit_log where action = 'kyc_photo_view' and target_id is not null
          and not exists (select 1 from public.kyc_submissions k where k.id = target_id)) orphan_view_rows;
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

steps=("$@"); [ ${#steps[@]} -eq 0 ] && steps=(t1 t2 t3 t4 t5 t6 t7 t8 t10 t9)
step setup
for s in "${steps[@]}"; do step "$s"; echo; done
echo "== $FAILS check(s) failed"
exit $FAILS
