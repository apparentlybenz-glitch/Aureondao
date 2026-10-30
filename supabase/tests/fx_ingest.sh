#!/bin/bash
# Forex feed tests (20261031130000_fx_ingest): private.fx_tick (hourly slot, minute 5, demand,
# market hours, monthly cap), request_fx_feed (throttle, market status), fx_next_open and
# grants. Prints PASS/FAIL lines (no keys) and exits non-zero if any check fails.
# Usage: supabase/tests/fx_ingest.sh [t1 ... t8]  (Management API, write token required;
# run it only after the migration is applied)
# Each step is ONE request that ends by raising its results, so it rolls back and commits
# nothing. fx_tick takes the instant as a parameter. A tick that claims a slot either returns
# not_configured (no fx_ingest_secret in Vault) or queues a pg_net post inside the rolled-back
# transaction, which is never sent: no test reaches fx-ingest or Open Exchange Rates.
# The project comes from SUPABASE_PROJECT_REF; abort before any query unless it matches the
# ref in NEXT_PUBLIC_SUPABASE_URL.
REF=${SUPABASE_PROJECT_REF:?SUPABASE_PROJECT_REF is not set}
URL_REF=$(printf '%s' "${NEXT_PUBLIC_SUPABASE_URL:-}" | sed -nE 's#^https://([a-z0-9]+)\.supabase\.co/?$#\1#p')
if [ "$REF" != "$URL_REF" ]; then echo "SUPABASE_PROJECT_REF does not match NEXT_PUBLIC_SUPABASE_URL; aborting." >&2; exit 1; fi
FAILS=0
run() { jq -Rs '{query: ., read_only: false}' | curl -sS -X POST "https://api.supabase.com/v1/projects/$REF/database/query" -H 'Content-Type: application/json' --data-binary @-; echo; }

read -r -d '' PRELUDE <<'SQL'
create temp table fx_t (n serial, label text, ok boolean, got text);
create function pg_temp.chk(p_label text, p_ok boolean, p_got text default null) returns void language sql as
  $f$ insert into fx_t (label, ok, got) values (p_label, coalesce(p_ok, false), p_got) $f$;
create function pg_temp.u(p text) returns uuid language sql immutable as $f$
  select case p when 'A' then 'aaaaaaaa-0000-4000-8000-0000000000a1'::uuid when 'B' then 'bbbbbbbb-0000-4000-8000-0000000000b1'::uuid end $f$;
-- Run SQL as a role and return the first column of the first row as text, or 'ERR <message>'.
create function pg_temp.as_role(p_role text, p_uid uuid, p_sql text) returns text language plpgsql as $f$
declare v text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', p_role, 'aal', 'aal1', 'user_role', 'user')::text, true);
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
end $f$;
create function pg_temp.tick(p_at text) returns text language sql as $f$ select private.fx_tick(p_at::timestamptz) $f$;
-- A claim is a tick that took the slot: it posts (called) or finds no Vault secret (not_configured).
create function pg_temp.claimed(p text) returns boolean language sql immutable as $f$ select p in ('called', 'not_configured') $f$;
create function pg_temp.st() returns public.fx_state language sql stable as $f$ select * from public.fx_state where id $f$;
create function pg_temp.reset(p_demand_until timestamptz default null) returns void language sql as
  $f$ update public.fx_state set slot_hour = null, demand_until = p_demand_until, month_key = null, month_calls = 0 where id $f$;
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', pg_temp.u(x), 'authenticated', 'authenticated', 'fx-ingest-test-' || lower(x) || '@aureonx.invalid',
       '', now(), '{}', json_build_object('nickname', 'Test' || x)::jsonb, now(), now()
  from unnest(array['A','B']) x;
SQL

read -r -d '' FINALE <<'SQL'
do $f$ begin
  raise exception 'FXTEST %', (select coalesce(jsonb_agg(jsonb_build_object('l', label, 'ok', ok, 'got', got) order by n), '[]'::jsonb)::text from fx_t);
end $f$;
SQL

body() {
case "$1" in
t1) cat <<'SQL'
-- T1 one claim per clock hour, never before minute 5 (Wednesday 2026-11-04, both classes open).
select pg_temp.reset('2026-11-04 18:00:00+00');
select pg_temp.chk('minutes 0 to 4 are early and claim nothing',
         bool_and(pg_temp.tick(format('2026-11-04 15:%s:30+00', lpad(m::text, 2, '0'))) = 'early') and (pg_temp.st()).month_calls = 0, null)
  from generate_series(0, 4) m;
select pg_temp.chk('55 ticks from 15:05 to 15:59 claim exactly once, at 15:05',
         count(*) filter (where pg_temp.claimed(r)) = 1 and bool_and(r = 'taken' or (m = 5 and pg_temp.claimed(r))),
         string_agg(distinct r, ','))
  from (select m, pg_temp.tick(format('2026-11-04 15:%s:00+00', lpad(m::text, 2, '0'))) r from generate_series(5, 59) m order by m) s;
select pg_temp.chk('the slot is 15:00 and the month count 1',
         (pg_temp.st()).slot_hour = '2026-11-04 15:00:00+00' and (pg_temp.st()).month_calls = 1 and (pg_temp.st()).month_key = '2026-11', null);
select pg_temp.chk('the same minute again is taken', pg_temp.tick('2026-11-04 15:05:00+00') = 'taken', null);
select pg_temp.chk('16:04:59 is early', pg_temp.tick('2026-11-04 16:04:59+00') = 'early', null);
select pg_temp.chk('16:05 claims the next hour', pg_temp.claimed(pg_temp.tick('2026-11-04 16:05:00+00')), null);
select pg_temp.chk('an earlier hour never claims again', pg_temp.tick('2026-11-04 15:30:00+00') = 'taken', null);
select pg_temp.chk('two claims in two hours', (pg_temp.st()).month_calls = 2 and (pg_temp.st()).slot_hour = '2026-11-04 16:00:00+00', null);
SQL
;;
t2) cat <<'SQL'
-- T2 demand: a heartbeat window, a pending position or an open position. Settled and void do not count.
select pg_temp.chk('precondition: no pending or open fx_positions on this database',
         not exists (select 1 from public.fx_positions where status in ('pending', 'open')), null);
select pg_temp.reset();
select pg_temp.chk('no demand and no position: no_demand, nothing claimed',
         pg_temp.tick('2026-11-04 15:10:00+00') = 'no_demand' and (pg_temp.st()).slot_hour is null and (pg_temp.st()).month_calls = 0, null);
select pg_temp.reset('2026-11-04 15:10:00+00');
select pg_temp.chk('demand that ends at the tick instant is over', pg_temp.tick('2026-11-04 15:10:00+00') = 'no_demand', null);
select pg_temp.reset('2026-11-04 15:10:01+00');
select pg_temp.chk('demand 1 s past the tick claims', pg_temp.claimed(pg_temp.tick('2026-11-04 15:10:00+00')), null);

select pg_temp.reset();
insert into public.fx_positions (user_id, instrument_id, direction, duration_s, premium_cents, fee_cents, profit_rate_bps, created_at, status, client_request_id)
values (pg_temp.u('A'), 'EUR-USD', 'rise', 3600, 4900, 5, 600, now(), 'pending', gen_random_uuid());
select pg_temp.chk('a pending position and no other demand: claims', pg_temp.claimed(pg_temp.tick('2026-11-04 15:10:00+00')), null);
update public.fx_positions set status = 'open', entry_price = 1.1, entry_price_at = created_at + interval '5 minutes',
       expires_at = created_at + interval '65 minutes' where user_id = pg_temp.u('A');
select pg_temp.reset();
select pg_temp.chk('an open position and no other demand: claims', pg_temp.claimed(pg_temp.tick('2026-11-04 15:10:00+00')), null);
update public.fx_positions set status = 'void', payout_cents = premium_cents + fee_cents, settled_at = expires_at + interval '2 hours 16 minutes'
 where user_id = pg_temp.u('A');
select pg_temp.reset();
select pg_temp.chk('a void position is not demand', pg_temp.tick('2026-11-04 15:10:00+00') = 'no_demand', null);
SQL
;;
t3) cat <<'SQL'
-- T3 market hours: both closed means no call; one class closed still calls.
select pg_temp.reset('2027-12-31 00:00:00+00');
select pg_temp.chk('Wednesday 17:10 New York (metals break, fx open): claims', pg_temp.claimed(pg_temp.tick('2026-11-04 22:10:00+00')), null);
select pg_temp.chk('Friday 17:10 New York (both closed): closed', pg_temp.tick('2026-11-06 22:10:00+00') = 'closed', null);
select pg_temp.chk('Saturday: closed', pg_temp.tick('2026-11-07 16:10:00+00') = 'closed', null);
select pg_temp.chk('Sunday 16:59 New York: closed', pg_temp.tick('2026-11-08 21:59:00+00') = 'closed', null);
select pg_temp.chk('Sunday 17:10 New York (fx open, metal closed): claims', pg_temp.claimed(pg_temp.tick('2026-11-08 22:10:00+00')), null);
select pg_temp.chk('Sunday 18:10 New York (both open): claims', pg_temp.claimed(pg_temp.tick('2026-11-08 23:10:00+00')), null);
select pg_temp.chk('closed ticks claimed nothing: 3 calls', (pg_temp.st()).month_calls = 3, (pg_temp.st()).month_calls::text);
SQL
;;
t4) cat <<'SQL'
-- T4 the monthly cap of 950 calls (UTC calendar month).
select pg_temp.reset('2027-12-31 00:00:00+00');
update public.fx_state set month_key = '2026-11', month_calls = 949 where id;
select pg_temp.chk('call 950 of the month claims', pg_temp.claimed(pg_temp.tick('2026-11-30 21:10:00+00')), null);
select pg_temp.chk('... the count is 950', (pg_temp.st()).month_calls = 950, (pg_temp.st()).month_calls::text);
select pg_temp.chk('the next hour is capped', pg_temp.tick('2026-11-30 23:10:00+00') = 'capped', null);
select pg_temp.chk('... the count stays 950 and the hour is spent', (pg_temp.st()).month_calls = 950
         and (pg_temp.st()).slot_hour = '2026-11-30 23:00:00+00', null);
select pg_temp.chk('the same capped hour does not warn again (taken)', pg_temp.tick('2026-11-30 23:40:00+00') = 'taken', null);
select pg_temp.chk('the first hour of December (UTC) claims', pg_temp.claimed(pg_temp.tick('2026-12-01 00:10:00+00')), null);
select pg_temp.chk('... and starts the December count at 1', (pg_temp.st()).month_key = '2026-12' and (pg_temp.st()).month_calls = 1, null);
SQL
;;
t5) cat <<'SQL'
-- T5 request_fx_feed: per-user 30 s throttle, demand to now + 5 min, output shape.
select pg_temp.reset();
select pg_temp.chk('first call returns fx, metal and demand_until',
         v::jsonb ? 'fx' and v::jsonb ? 'metal' and (v::jsonb ->> 'demand_until')::timestamptz = now() + interval '5 minutes'
         and (v::jsonb -> 'fx') ?& array['closed', 'opens_at', 'closes_at'], v)
  from (select pg_temp.as_role('authenticated', pg_temp.u('A'), 'select public.request_fx_feed()::text') v) s;
update public.fx_state set demand_until = now() where id;
select pg_temp.chk('a second call within 30 s changes nothing', (v::jsonb ->> 'demand_until')::timestamptz = now(), v)
  from (select pg_temp.as_role('authenticated', pg_temp.u('A'), 'select public.request_fx_feed()::text') v) s;
select pg_temp.chk('another user is not throttled by A', (v::jsonb ->> 'demand_until')::timestamptz = now() + interval '5 minutes', v)
  from (select pg_temp.as_role('authenticated', pg_temp.u('B'), 'select public.request_fx_feed()::text') v) s;
update public.fx_state set demand_until = now() where id;
update public.profiles set fx_feed_requested_at = now() - interval '29 seconds' where id = pg_temp.u('A');
select pg_temp.as_role('authenticated', pg_temp.u('A'), 'select public.request_fx_feed()::text');
select pg_temp.chk('29 s after the last accepted call: still throttled', (pg_temp.st()).demand_until = now(), (pg_temp.st()).demand_until::text);
update public.profiles set fx_feed_requested_at = now() - interval '30 seconds' where id = pg_temp.u('A');
select pg_temp.chk('30 s after: accepted again', (v::jsonb ->> 'demand_until')::timestamptz = now() + interval '5 minutes', v)
  from (select pg_temp.as_role('authenticated', pg_temp.u('A'), 'select public.request_fx_feed()::text') v) s;
update public.fx_state set demand_until = now() + interval '20 minutes' where id;
update public.profiles set fx_feed_requested_at = null where id = pg_temp.u('A');
select pg_temp.as_role('authenticated', pg_temp.u('A'), 'select public.request_fx_feed()::text');
select pg_temp.chk('an accepted call never shortens a longer window', (pg_temp.st()).demand_until = now() + interval '20 minutes'
         and (select fx_feed_requested_at from public.profiles where id = pg_temp.u('A')) = now(), null);
select pg_temp.chk('no user: UNAUTHENTICATED', pg_temp.as_role('authenticated', null, 'select public.request_fx_feed()::text') ~ 'UNAUTHENTICATED', null);
select pg_temp.chk('anon: permission denied', pg_temp.as_role('anon', null, 'select public.request_fx_feed()::text') ~ 'permission denied', null);
SQL
;;
t6) cat <<'SQL'
-- T6 market status (the body of request_fx_feed) on both sides of both DST dates.
select pg_temp.chk(format('%s %s: closed=%s opens_at=%s closes_at=%s', c, a, cl, coalesce(op, 'null'), cs),
         (s -> c ->> 'closed')::boolean = cl
         and (s -> c ->> 'opens_at')::timestamptz is not distinct from op::timestamptz
         and (s -> c ->> 'closes_at')::timestamptz = cs::timestamptz, (s -> c)::text)
  from (values
    ('fx',    '2026-10-30 22:00:00+00', true,  '2026-11-01 22:00:00+00', '2026-11-06 22:00:00+00'),   -- Friday 18:00 EDT, reopens Sunday 17:00 EST
    ('metal', '2026-10-30 22:00:00+00', true,  '2026-11-01 23:00:00+00', '2026-11-02 22:00:00+00'),
    ('fx',    '2026-11-01 21:30:00+00', true,  '2026-11-01 22:00:00+00', '2026-11-06 22:00:00+00'),   -- Sunday 16:30 EST (DST end day)
    ('metal', '2026-11-01 22:30:00+00', true,  '2026-11-01 23:00:00+00', '2026-11-02 22:00:00+00'),   -- Sunday 17:30 EST
    ('fx',    '2026-11-01 22:30:00+00', false, null,                     '2026-11-06 22:00:00+00'),
    ('fx',    '2026-11-04 15:00:00+00', false, null,                     '2026-11-06 22:00:00+00'),   -- Wednesday 10:00 EST
    ('metal', '2026-11-04 15:00:00+00', false, null,                     '2026-11-04 22:00:00+00'),
    ('metal', '2026-11-04 22:30:00+00', true,  '2026-11-04 23:00:00+00', '2026-11-05 22:00:00+00'),   -- Wednesday break
    ('fx',    '2027-03-12 23:00:00+00', true,  '2027-03-14 21:00:00+00', '2027-03-19 21:00:00+00'),   -- Friday 18:00 EST, reopens Sunday 17:00 EDT
    ('metal', '2027-03-12 23:00:00+00', true,  '2027-03-14 22:00:00+00', '2027-03-15 21:00:00+00'),
    ('fx',    '2027-03-14 21:30:00+00', false, null,                     '2027-03-19 21:00:00+00'),   -- Sunday 17:30 EDT (DST start day)
    ('metal', '2027-03-14 21:30:00+00', true,  '2027-03-14 22:00:00+00', '2027-03-15 21:00:00+00')
  ) t(c, a, cl, op, cs),
  lateral (select private.fx_market_status(t.a::timestamptz) s) x;
SQL
;;
t7) cat <<'SQL'
-- T7 fx_next_open for each closure type (null when open).
select pg_temp.chk(format('%s %s -> %s', c, a, coalesce(e, 'null')),
         private.fx_next_open(c::public.fx_class, a::timestamptz) is not distinct from e::timestamptz,
         private.fx_next_open(c::public.fx_class, a::timestamptz)::text)
  from (values
    ('fx',    '2026-11-06 17:00:00 America/New_York', '2026-11-08 17:00:00 America/New_York'),   -- weekend, at the close instant
    ('fx',    '2026-11-07 12:00:00 America/New_York', '2026-11-08 17:00:00 America/New_York'),   -- Saturday
    ('fx',    '2026-11-08 16:59:59 America/New_York', '2026-11-08 17:00:00 America/New_York'),
    ('fx',    '2026-11-08 17:00:00 America/New_York', null),                                     -- open at the reopen instant
    ('fx',    '2026-11-04 17:30:00 America/New_York', null),                                     -- fx has no daily break
    ('metal', '2026-11-06 17:00:00 America/New_York', '2026-11-08 18:00:00 America/New_York'),   -- weekend
    ('metal', '2026-11-08 17:30:00 America/New_York', '2026-11-08 18:00:00 America/New_York'),   -- Sunday after fx reopens
    ('metal', '2026-11-04 17:00:00 America/New_York', '2026-11-04 18:00:00 America/New_York'),   -- daily break, at its start
    ('metal', '2026-11-05 17:59:59 America/New_York', '2026-11-05 18:00:00 America/New_York'),   -- Thursday break
    ('metal', '2026-11-04 18:00:00 America/New_York', null),
    ('fx',    '2026-10-31 12:00:00 America/New_York', '2026-11-01 17:00:00 America/New_York'),   -- across the DST end
    ('metal', '2027-03-13 12:00:00 America/New_York', '2027-03-14 18:00:00 America/New_York')    -- across the DST start
  ) t(c, a, e);
SQL
;;
t8) cat <<'SQL'
-- T8 grants, RLS, the cron job and function hygiene.
select pg_temp.chk(format('EXECUTE %s for %s = %s', f, r, e), has_function_privilege(r, f, 'execute') = e, null)
  from (values
    ('private.fx_tick(timestamptz)', 'anon', false), ('private.fx_tick(timestamptz)', 'authenticated', false),
    ('private.fx_next_open(public.fx_class, timestamptz)', 'authenticated', false),
    ('private.fx_market_status(timestamptz)', 'authenticated', false),
    ('public.request_fx_feed()', 'anon', false), ('public.request_fx_feed()', 'authenticated', true),
    ('public.fx_record_call(integer, timestamptz)', 'anon', false), ('public.fx_record_call(integer, timestamptz)', 'authenticated', false),
    ('public.fx_record_call(integer, timestamptz)', 'service_role', true)
  ) t(f, r, e);
select pg_temp.chk('fx_state: RLS on, one row', (select relrowsecurity from pg_class where oid = 'public.fx_state'::regclass)
         and (select count(*) from public.fx_state) = 1, null);
select pg_temp.chk('authenticated cannot read fx_state', pg_temp.as_role('authenticated', pg_temp.u('A'), 'select count(*) from public.fx_state') ~ 'permission denied', null);
select pg_temp.chk('anon cannot read fx_state', pg_temp.as_role('anon', null, 'select count(*) from public.fx_state') ~ 'permission denied', null);
select pg_temp.chk('authenticated cannot write fx_state', pg_temp.as_role('authenticated', pg_temp.u('A'), 'update public.fx_state set month_calls = 0') ~ 'permission denied', null);
select pg_temp.chk('authenticated cannot call fx_record_call', pg_temp.as_role('authenticated', pg_temp.u('A'), 'select public.fx_record_call(200)') ~ 'permission denied', null);
select pg_temp.chk('the tick job runs every minute', (select schedule from cron.job where jobname = 'aureonx-fx-tick') = '* * * * *'
         and (select command from cron.job where jobname = 'aureonx-fx-tick') ~ 'private\.fx_tick\(\)', null);
select pg_temp.chk('every new function sets search_path to empty', count(*) = 5 and bool_and(p.proconfig @> array['search_path=""']), count(*)::text)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where (n.nspname, p.proname) in (('private','fx_next_open'), ('private','fx_market_status'), ('private','fx_tick'),
                                  ('public','request_fx_feed'), ('public','fx_record_call'));
select public.fx_record_call(200, '2026-11-04 15:00:00+00');
select public.fx_record_call(429);
select pg_temp.chk('fx_record_call records the status and time and keeps the last print ts on a failure', (pg_temp.st()).last_http_status = 429
         and (pg_temp.st()).last_call_at = now() and (pg_temp.st()).last_print_ts = '2026-11-04 15:00:00+00', null);
SQL
;;
*) echo "unknown step $1" >&2; return 1;;
esac
}

steps=("$@"); [ ${#steps[@]} -eq 0 ] && steps=(t1 t2 t3 t4 t5 t6 t7 t8)
for s in "${steps[@]}"; do
  echo "== $s"
  sql=$(body "$s") || { FAILS=$((FAILS+1)); continue; }
  out=$(printf '%s\n%s\n%s\n' "$PRELUDE" "$sql" "$FINALE" | run)
  res=$(printf '%s' "$out" | jq -r '.message // empty' 2>/dev/null | sed -n 's/.*FXTEST //p' | head -1)
  if [ -z "$res" ]; then echo "FAIL $s did not finish: $out"; FAILS=$((FAILS+1)); continue; fi
  printf '%s' "$res" | jq -r '.[] | if .ok then "PASS " + .l else "FAIL " + .l + " (got: " + (.got // "null") + ")" end'
  FAILS=$((FAILS + $(printf '%s' "$res" | jq '[.[] | select(.ok | not)] | length')))
done
echo "failures: $FAILS"
exit $FAILS
