#!/bin/bash
# Forex money path tests (fx tables, open_fx_position, the pending entry in ingest_fx_rates,
# settle_fx, void_stale_fx, admin_set_fx_period, market hours). Prints PASS/FAIL lines (no keys)
# and exits non-zero if any check fails.
# Usage: supabase/tests/forex.sh [t1 ... t8]  (Management API, write token required)
# Each step is ONE request: it creates its test users, runs its checks and ends by raising an
# exception that carries the results, so the whole step rolls back and nothing is ever
# committed. No cleanup is needed and live cron jobs never see the test rows.
# Market hours: steps that open positions replace private.fx_is_closed and private.fx_next_close
# inside that rolled-back transaction with copies that read a fixed New York instant
# (pg_temp.clock), so the result does not depend on the day the tests run.
# Rates are fixture bodies in the Open Exchange Rates latest.json shape, sent as text.
# The project comes from SUPABASE_PROJECT_REF; abort before any query unless it matches the
# ref in NEXT_PUBLIC_SUPABASE_URL.
REF=${SUPABASE_PROJECT_REF:?SUPABASE_PROJECT_REF is not set}
URL_REF=$(printf '%s' "${NEXT_PUBLIC_SUPABASE_URL:-}" | sed -nE 's#^https://([a-z0-9]+)\.supabase\.co/?$#\1#p')
if [ "$REF" != "$URL_REF" ]; then echo "SUPABASE_PROJECT_REF does not match NEXT_PUBLIC_SUPABASE_URL; aborting." >&2; exit 1; fi
FAILS=0
run() { jq -Rs '{query: ., read_only: false}' | curl -sS -X POST "https://api.supabase.com/v1/projects/$REF/database/query" -H 'Content-Type: application/json' --data-binary @-; echo; }

# Helpers created at the start of every step (temporary, dropped with the rollback).
read -r -d '' PRELUDE <<'SQL'
create temp table fx_t (n serial, label text, ok boolean, got text);
create function pg_temp.chk(p_label text, p_ok boolean, p_got text default null) returns void language sql as
  $f$ insert into fx_t (label, ok, got) values (p_label, coalesce(p_ok, false), p_got) $f$;
-- Test users: A trader (forex 30,000.00), B admin, C forex 49.00 (covers the minimum premium,
-- not the fee), D trader (forex 1,000.00) who is suspended during t3.
create function pg_temp.u(p text) returns uuid language sql immutable as $f$
  select case p when 'A' then 'aaaaaaaa-0000-4000-8000-0000000000fa'::uuid when 'B' then 'bbbbbbbb-0000-4000-8000-0000000000fb'::uuid
                when 'C' then 'cccccccc-0000-4000-8000-0000000000fc'::uuid when 'D' then 'dddddddd-0000-4000-8000-0000000000fd'::uuid end $f$;
create function pg_temp.k(n integer) returns uuid language sql immutable as
  $f$ select ('f0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $f$;
-- Run SQL as a role and return the first column of the first row as text, or 'ERR <message> detail=<detail>'.
create function pg_temp.as_role(p_role text, p_uid uuid, p_user_role text, p_sql text) returns text language plpgsql as $f$
declare v text; v_d text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', p_role, 'aal', 'aal1', 'user_role', p_user_role)::text, true);
  execute format('set local role %I', p_role);
  begin
    execute p_sql into v;
    v := coalesce(v, 'ok');
  exception when others then
    get stacked diagnostics v_d = pg_exception_detail;
    v := 'ERR ' || sqlerrm || coalesce(' detail=' || nullif(v_d, ''), '');
  end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  return v;
end $f$;
create function pg_temp.as_user(p_uid uuid, p_sql text) returns text language sql as
  $f$ select pg_temp.as_role('authenticated', p_uid, 'user', p_sql) $f$;
create function pg_temp.open(p_who text, p_instrument text, p_dir text, p_duration integer, p_premium bigint, p_key integer) returns text language sql as
  $f$ select pg_temp.as_user(pg_temp.u(p_who), format('select public.open_fx_position(%L, %L, %s, %s, %L)',
        p_instrument, p_dir, p_duration, p_premium, pg_temp.k(p_key))) $f$;
-- Run SQL as postgres and return 'ok' or the error.
create function pg_temp.try(p_sql text) returns text language plpgsql as $f$
begin execute p_sql; return 'ok'; exception when others then return 'ERR ' || sqlerrm; end $f$;
create function pg_temp.j(p text) returns jsonb language plpgsql immutable as
  $f$ begin return p::jsonb; exception when others then return null; end $f$;
-- The fixture USD table. JPY 152.3445 sits on a rounding boundary: half up gives 152.345.
create function pg_temp.rates() returns text language sql immutable as $f$
  select '{"USD":1,"EUR":0.921234,"GBP":0.771234,"JPY":152.3445,"CHF":0.861234,"CAD":1.381234,"AUD":1.521234,"NZD":1.671234,"XAU":0.000251234,"XAG":0.0301234}' $f$;
-- The fixture table with another EUR rate (1 / EUR is the EUR-USD price).
create function pg_temp.rates_eur(p_eur text) returns text language sql immutable as
  $f$ select replace(pg_temp.rates(), '"EUR":0.921234', '"EUR":' || p_eur) $f$;
create function pg_temp.body(p_age interval, p_rates text, p_base text default 'USD') returns text language sql stable as
  $f$ select format('{"disclaimer":"Usage subject to terms","license":"https://openexchangerates.org/license","timestamp":%s,"base":"%s","rates":%s}',
        floor(extract(epoch from now() - p_age))::bigint, p_base, p_rates) $f$;
create function pg_temp.ingest_raw(p_body text) returns text language sql as
  $f$ select pg_temp.as_role('service_role', null, null, format('select public.ingest_fx_rates(%L)::text', p_body)) $f$;
create function pg_temp.ingest(p_age interval, p_rates text default null, p_base text default 'USD') returns text language sql as
  $f$ select pg_temp.ingest_raw(pg_temp.body(p_age, coalesce(p_rates, pg_temp.rates()), p_base)) $f$;
-- T0 = now() truncated to the second; ingest_at writes a table whose timestamp is exactly p_ts
-- (a whole second), so entry and settle times can be checked to the second.
create function pg_temp.t0() returns timestamptz language sql stable as $f$ select date_trunc('second', now()) $f$;
create function pg_temp.ingest_at(p_ts timestamptz, p_rates text default null) returns text language sql as
  $f$ select pg_temp.ingest_raw(format('{"timestamp":%s,"base":"USD","rates":%s}', floor(extract(epoch from p_ts))::bigint,
        coalesce(p_rates, pg_temp.rates()))) $f$;
-- Move the open time of pending positions (they have no entry or expiry yet).
create function pg_temp.created(p_at timestamptz, p_keys integer[]) returns void language sql as $f$
  update public.fx_positions set created_at = p_at
   where status = 'pending' and client_request_id in (select pg_temp.k(x) from unnest(p_keys) x) $f$;
-- Market hours read p_at as if now() were the given instant (this transaction only).
create function pg_temp.clock(p_at timestamptz) returns void language plpgsql as $f$
begin
  if to_regprocedure('private.fx_is_closed_real(public.fx_class, timestamptz)') is null then
    alter function private.fx_is_closed(public.fx_class, timestamptz) rename to fx_is_closed_real;
    alter function private.fx_next_close(public.fx_class, timestamptz) rename to fx_next_close_real;
  end if;
  execute format($s$create or replace function private.fx_is_closed(p_class public.fx_class, p_at timestamptz)
    returns boolean language sql stable set search_path = '' as
    $b$ select private.fx_is_closed_real(p_class, p_at + %L::interval) $b$$s$, p_at - now());
  execute format($s$create or replace function private.fx_next_close(p_class public.fx_class, p_at timestamptz)
    returns timestamptz language sql stable set search_path = '' as
    $b$ select private.fx_next_close_real(p_class, p_at + %1$L::interval) - %1$L::interval $b$$s$, p_at - now());
end $f$;
-- Move open positions back in time (created_at, expires_at and entry_price_at together).
create function pg_temp.shift(p_secs integer, p_keys integer[]) returns void language sql as $f$
  update public.fx_positions set created_at = created_at - make_interval(secs => p_secs),
         expires_at = expires_at - make_interval(secs => p_secs), entry_price_at = entry_price_at - make_interval(secs => p_secs)
   where status = 'open' and client_request_id in (select pg_temp.k(x) from unnest(p_keys) x) $f$;
create function pg_temp.pos(p_key integer) returns public.fx_positions language sql stable as
  $f$ select * from public.fx_positions where client_request_id = pg_temp.k(p_key) $f$;
create function pg_temp.bills(p_key integer) returns text language sql stable as $f$
  select string_agg(l.kind || ' ' || l.delta_cents || ' pnl ' || l.pnl_cents, ', ' order by l.id)
    from public.ledger l where l.ref_type = 'forex_position' and l.ref_id = (pg_temp.pos(p_key)).id $f$;
create function pg_temp.wallet(p text) returns bigint language sql stable as
  $f$ select available_cents from public.wallets where user_id = pg_temp.u(p) and account = 'forex' $f$;

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', pg_temp.u(x), 'authenticated', 'authenticated', 'forex-test-' || lower(x) || '@aureonx.invalid',
       '', now(), '{}', json_build_object('nickname', 'Test' || x)::jsonb, now(), now()
  from unnest(array['A','B','C','D']) x;
insert into public.user_roles (user_id, role) values (pg_temp.u('B'), 'admin');
select private.wallet_apply((select id from public.wallets where user_id = pg_temp.u(x) and account = 'forex'),
         c, 0, 'admin_credit', 'admin_adjustment', gen_random_uuid(), p_memo => 'Balance adjustment')
  from (values ('A', 3000000::bigint), ('C', 4900), ('D', 100000)) v(x, c);
SQL

read -r -d '' FINALE <<'SQL'
do $f$ begin
  raise exception 'FXTEST %', (select coalesce(jsonb_agg(jsonb_build_object('l', label, 'ok', ok, 'got', got) order by n), '[]'::jsonb)::text from fx_t);
end $f$;
SQL

body() {
case "$1" in
t1) cat <<'SQL'
-- T1 ingest_fx_rates: refusals, derivation and rounding, skipped instruments, forward-only inserts.
select pg_temp.chk('body that is not JSON -> FX_INVALID_BODY', v ~ 'FX_INVALID_BODY', v) from (select pg_temp.ingest_raw('not json') v) s;
select pg_temp.chk('body without rates -> FX_INVALID_BODY', v ~ 'FX_INVALID_BODY', v)
  from (select pg_temp.ingest_raw(format('{"base":"USD","timestamp":%s}', floor(extract(epoch from now()))::bigint)) v) s;
select pg_temp.chk('body with a NUL escape -> FX_INVALID_BODY', v ~ 'FX_INVALID_BODY', v)
  from (select pg_temp.ingest_raw('{"base":"USD","timestamp":1,"rates":{},"x":"\u0000"}') v) s;
select pg_temp.chk('base EUR -> FX_INVALID_BASE', v ~ 'FX_INVALID_BASE', v) from (select pg_temp.ingest(interval '10 minutes', null, 'EUR') v) s;
select pg_temp.chk('timestamp 2 h 1 s old -> FX_INVALID_TIMESTAMP', v ~ 'FX_INVALID_TIMESTAMP', v) from (select pg_temp.ingest(interval '2 hours 1 second') v) s;
select pg_temp.chk('timestamp 6 min ahead -> FX_INVALID_TIMESTAMP', v ~ 'FX_INVALID_TIMESTAMP', v) from (select pg_temp.ingest(interval '-6 minutes') v) s;
select pg_temp.chk('fractional timestamp -> FX_INVALID_TIMESTAMP', v ~ 'FX_INVALID_TIMESTAMP', v)
  from (select pg_temp.ingest_raw(format('{"base":"USD","timestamp":%s.5,"rates":%s}', floor(extract(epoch from now()))::bigint, pg_temp.rates())) v) s;
select pg_temp.chk('timestamp as a string -> FX_INVALID_TIMESTAMP', v ~ 'FX_INVALID_TIMESTAMP', v)
  from (select pg_temp.ingest_raw(format('{"base":"USD","timestamp":"%s","rates":%s}', floor(extract(epoch from now()))::bigint, pg_temp.rates())) v) s;
select pg_temp.chk('every instrument skipped -> FX_NO_RATES', v ~ 'FX_NO_RATES', v) from (select pg_temp.ingest(interval '10 minutes', '{"USD":1,"EUR":0}') v) s;

select pg_temp.chk('table 1 h 59 min old accepted: 17 written, none skipped',
         pg_temp.j(v) ->> 'accepted' = '17' and pg_temp.j(v) -> 'skipped' = '[]'::jsonb, v)
  from (select pg_temp.ingest(interval '1 hour 59 minutes') v) s;
select pg_temp.chk('derived ' || e.id || ' = ' || e.v, p.price::text = e.v, p.price::text)
  from (values ('EUR-USD','1.08550'), ('GBP-USD','1.29662'), ('USD-JPY','152.345'), ('USD-CHF','0.86123'), ('USD-CAD','1.38123'),
               ('AUD-USD','0.65736'), ('NZD-USD','0.59836'), ('EUR-GBP','0.83717'), ('EUR-JPY','165.370'), ('GBP-JPY','197.533'),
               ('AUD-JPY','100.145'), ('XAU-USD','3980.35'), ('XAG-USD','33.197'), ('EUR-CHF','0.93487'), ('EUR-AUD','1.65130'),
               ('GBP-AUD','1.97247'), ('NZD-JPY','91.157')) e(id, v)
  left join public.fx_prices p on p.instrument_id = e.id and p.ingested_at = now();
select pg_temp.chk('every price has exactly price_decimals digits and source oxr',
         bool_and(scale(p.price) = i.price_decimals and p.source = 'oxr'), count(*)::text)
  from public.fx_prices p join public.fx_instruments i on i.id = p.instrument_id where p.ingested_at = now();

select pg_temp.chk('the same table again: 0 written, 17 ignored', pg_temp.j(v) ->> 'accepted' = '0' and pg_temp.j(v) ->> 'ignored' = '17', v)
  from (select pg_temp.ingest(interval '1 hour 59 minutes') v) s;
select pg_temp.chk('GBP missing, XAU 0, XAG a string: 6 skipped and reported, 11 written',
         pg_temp.j(v) ->> 'accepted' = '11'
         and pg_temp.j(v) -> 'skipped' = '["GBP-USD","EUR-GBP","GBP-JPY","XAU-USD","XAG-USD","GBP-AUD"]'::jsonb, v)
  from (select pg_temp.ingest(interval '90 minutes',
    '{"USD":1,"EUR":0.921234,"JPY":152.3445,"CHF":0.861234,"CAD":1.381234,"AUD":1.521234,"NZD":1.671234,"XAU":0,"XAG":"0.03"}') v) s;
select pg_temp.chk('an older table is forward-only per instrument: the 6 skipped ones written, 11 ignored',
         pg_temp.j(v) ->> 'accepted' = '6' and pg_temp.j(v) ->> 'ignored' = '11', v)
  from (select pg_temp.ingest(interval '110 minutes') v) s;
select pg_temp.chk('a table 4 min ahead is accepted', pg_temp.j(v) ->> 'accepted' = '17', v)
  from (select pg_temp.ingest(interval '-4 minutes') v) s;
select pg_temp.chk('... and stored clamped to now()', count(*) = 17, count(*)::text) from public.fx_prices where ts = now();
select pg_temp.chk('history: EUR-USD 3 rows (119, 90, 0 min), GBP-USD 3 rows (119, 110, 0 min)',
         count(*) filter (where instrument_id = 'EUR-USD') = 3 and count(*) filter (where instrument_id = 'GBP-USD') = 3,
         count(*)::text)
  from public.fx_prices where ingested_at = now();
SQL
;;
t2) cat <<'SQL'
-- T2 market hours with fixed instants. 2026-11-01 (Sunday) US DST ends; 2027-03-14 (Sunday) it starts.
select pg_temp.chk(format('%s %s closed=%s', c, a, e), private.fx_is_closed(c::public.fx_class, a::timestamptz) = e,
                   private.fx_is_closed(c::public.fx_class, a::timestamptz)::text)
  from (values
    ('fx',    '2026-10-30 16:59:59 America/New_York', false), ('fx',    '2026-10-30 17:00:00 America/New_York', true),
    ('fx',    '2026-10-31 12:00:00 America/New_York', true),
    ('fx',    '2026-11-01 01:30:00 America/New_York', true),  ('fx',    '2026-11-01 16:59:59 America/New_York', true),
    ('fx',    '2026-11-01 17:00:00 America/New_York', false), ('fx',    '2026-11-01 21:59:59+00', true),
    ('fx',    '2026-11-01 22:00:00+00', false),              ('fx',    '2026-11-02 17:30:00 America/New_York', false),
    ('fx',    '2026-11-06 21:59:59+00', false),              ('fx',    '2026-11-06 22:00:00+00', true),
    ('fx',    '2027-03-12 21:59:59+00', false),              ('fx',    '2027-03-12 22:00:00+00', true),
    ('fx',    '2027-03-14 20:59:59+00', true),               ('fx',    '2027-03-14 21:00:00+00', false),
    ('metal', '2026-10-30 16:59:59 America/New_York', false), ('metal', '2026-10-30 17:00:00 America/New_York', true),
    ('metal', '2026-11-01 17:30:00 America/New_York', true),  ('metal', '2026-11-01 22:59:59+00', true),
    ('metal', '2026-11-01 23:00:00+00', false),
    ('metal', '2026-11-02 21:59:59+00', false),              ('metal', '2026-11-02 22:00:00+00', true),
    ('metal', '2026-11-02 22:59:59+00', true),               ('metal', '2026-11-02 23:00:00+00', false),
    ('metal', '2026-11-05 17:30:00 America/New_York', true),  ('metal', '2026-11-06 16:59:59 America/New_York', false),
    ('metal', '2027-03-14 21:59:59+00', true),               ('metal', '2027-03-14 22:00:00+00', false),
    ('metal', '2027-03-15 20:59:59+00', false),              ('metal', '2027-03-15 21:00:00+00', true),
    ('metal', '2027-03-15 22:00:00+00', false)
  ) t(c, a, e);
select pg_temp.chk(format('%s next close after %s = %s', c, a, e), private.fx_next_close(c::public.fx_class, a::timestamptz) = e::timestamptz,
                   private.fx_next_close(c::public.fx_class, a::timestamptz)::text)
  from (values
    ('fx',    '2026-10-29 12:00:00+00', '2026-10-30 21:00:00+00'),   -- EDT Friday
    ('fx',    '2026-10-30 21:00:00+00', '2026-11-06 22:00:00+00'),   -- at a close: the next one, EST
    ('fx',    '2026-10-31 12:00:00+00', '2026-11-06 22:00:00+00'),   -- across the DST end
    ('fx',    '2026-11-01 22:00:00+00', '2026-11-06 22:00:00+00'),
    ('fx',    '2027-03-12 22:30:00+00', '2027-03-19 21:00:00+00'),   -- across the DST start
    ('fx',    '2027-03-14 21:00:00+00', '2027-03-19 21:00:00+00'),
    ('metal', '2026-10-30 20:00:00+00', '2026-10-30 21:00:00+00'),
    ('metal', '2026-11-01 23:00:00+00', '2026-11-02 22:00:00+00'),   -- Sunday open to Monday break, EST
    ('metal', '2026-11-02 23:00:00+00', '2026-11-03 22:00:00+00'),
    ('metal', '2026-11-05 23:30:00+00', '2026-11-06 22:00:00+00'),   -- Thursday to the Friday close
    ('metal', '2027-03-14 22:00:00+00', '2027-03-15 21:00:00+00')    -- EDT Monday break
  ) t(c, a, e);
SQL
;;
t3) cat <<'SQL'
-- T3 pending entry, settle and void (market hours read as Wednesday 2026-11-04 10:00 New York).
-- The payout figures below assume 600 / 10 bps and a 49.00 minimum (the live 30 s Options row at apply time).
-- Times are offsets from T0 (now() to the second). Prints in time order:
--   P0 T0-69m EUR-USD 1.05263 (the newest print at open), T0-61m01s 1.07527, T0-61m 1.08550, T0-30s 1.08696.
-- Open times set after the opens: G1 T0-66m (guard T0-61m), k4 T0-68m (guard T0-63m), k5 T0-20m.
update public.fx_periods set profit_rate_bps = 600, fee_bps = 10, min_premium_cents = 4900, enabled = true where duration_s = 3600;
select pg_temp.clock('2026-11-04 10:00:00 America/New_York');
select pg_temp.chk('P0 ingested 69 min ago (inside the 70 min feed guard)', pg_temp.j(v) ->> 'accepted' = '17', v)
  from (select pg_temp.ingest_at(pg_temp.t0() - interval '69 minutes', pg_temp.rates_eur('0.95')) v) s;
select pg_temp.chk('open ' || x.l, pg_temp.open(x.who, x.ins, x.dir, 3600, x.prem, x.k) ~ '^[0-9a-f-]{36}$', pg_temp.open(x.who, x.ins, x.dir, 3600, x.prem, x.k))
  from (values ('win', 'A', 'EUR-USD', 'rise', 659000, 1), ('loss', 'A', 'EUR-USD', 'fall', 659000, 2),
               ('draw', 'A', 'USD-JPY', 'rise', 659000, 3), ('later print', 'A', 'EUR-USD', 'rise', 4900, 4),
               ('waiting', 'A', 'EUR-USD', 'rise', 4900, 5), ('late', 'A', 'EUR-USD', 'rise', 4900, 6),
               ('near void', 'A', 'EUR-USD', 'rise', 4900, 7), ('D before suspension', 'D', 'EUR-USD', 'rise', 4900, 8),
               ('pending void', 'A', 'AUD-USD', 'rise', 4900, 10), ('pending near void', 'A', 'AUD-USD', 'rise', 4900, 11)) x(l, who, ins, dir, prem, k);
select pg_temp.chk('open gives pending rows with no entry price, entry time, expiry or payout, created_at = now()',
         count(*) = 10 and bool_and(status = 'pending' and entry_price is null and entry_price_at is null and expires_at is null
                                    and payout_cents is null and settled_at is null and created_at = now()), count(*)::text)
  from public.fx_positions;
select pg_temp.chk('659,000 premium: fee ceil(659) on top; Bills forex_margin and fee (pnl -fee)',
         (pg_temp.pos(1)).fee_cents = 659 and pg_temp.bills(1) = 'forex_margin -659000 pnl 0, fee -659 pnl -659', pg_temp.bills(1));
select pg_temp.chk('49.00 premium: fee ceil(4.9) = 5', (pg_temp.pos(4)).fee_cents = 5, (pg_temp.pos(4)).fee_cents::text);
select pg_temp.chk('A forex wallet after opens = 30,000.00 - 3 x 6,596.59 - 6 x 49.05', pg_temp.wallet('A') = 3000000 - 3 * 659659 - 6 * 4905,
                   pg_temp.wallet('A')::text);
update public.profiles set suspended_at = now() where id = pg_temp.u('D');
select pg_temp.chk('suspended account -> ACCOUNT_SUSPENDED, nothing written', v ~ 'ACCOUNT_SUSPENDED' and pg_temp.wallet('D') = 100000 - 4905, v)
  from (select pg_temp.open('D', 'EUR-USD', 'rise', 3600, 4900, 9) v) s;

select pg_temp.created(pg_temp.t0() - interval '66 minutes', array[1, 2, 3, 6, 7, 8]);
select pg_temp.created(pg_temp.t0() - interval '68 minutes', array[4]);
select pg_temp.created(pg_temp.t0() - interval '20 minutes', array[5]);
select pg_temp.chk('a print 1 s before created_at + 5 min of G1 enters 1 position', pg_temp.j(v) ->> 'entered' = '1', v)
  from (select pg_temp.ingest_at(pg_temp.t0() - interval '61 minutes 1 second', pg_temp.rates_eur('0.93')) v) s;
select pg_temp.chk('... G1 stays pending', bool_and(status = 'pending'), count(*)::text)
  from public.fx_positions where client_request_id in (select pg_temp.k(x) from unnest(array[1, 2, 3, 6, 7, 8]) x);
select pg_temp.chk('... k4 (guard T0-63m) enters at this later print (1.07527 at T0-61m01s)',
         (p).status = 'open' and (p).entry_price::text = '1.07527' and (p).entry_price_at = pg_temp.t0() - interval '61 minutes 1 second', (p).entry_price::text)
  from (select pg_temp.pos(4) p) s;
select pg_temp.chk('a print at exactly created_at + 5 min enters G1 (6 positions), settles nothing',
         pg_temp.j(v) ->> 'entered' = '6' and pg_temp.j(v) ->> 'settled' = '0', v)
  from (select pg_temp.ingest_at(pg_temp.t0() - interval '61 minutes') v) s;
select pg_temp.chk('entry = that print (EUR-USD 1.08550 at created_at + 5 min), status open',
         (p).status = 'open' and (p).entry_price::text = '1.08550' and (p).entry_price_at = (p).created_at + interval '5 minutes'
         and (p).entry_price_at = pg_temp.t0() - interval '61 minutes', (p).entry_price::text)
  from (select pg_temp.pos(1) p) s;
select pg_temp.chk('expires_at = entry_price_at + 3600 s for every entered position',
         bool_and(expires_at = entry_price_at + interval '1 hour'), count(*)::text) from public.fx_positions where status = 'open';
select pg_temp.chk('k4 kept its first entry', (pg_temp.pos(4)).entry_price::text = '1.07527', (pg_temp.pos(4)).entry_price::text);
select pg_temp.chk('regression: no entry is P0, the print that was newest at open',
         count(*) = 7 and bool_and(entry_price_at <> pg_temp.t0() - interval '69 minutes' and entry_price::text <> '1.05263'), count(*)::text)
  from public.fx_positions where entry_price is not null;
select pg_temp.chk('k5, k10, k11 still pending', (pg_temp.pos(5)).status = 'pending' and (pg_temp.pos(10)).status = 'pending'
         and (pg_temp.pos(11)).status = 'pending', null);

-- Late: expired 2 h 17 min ago. Near void: expired 2 h 10 min ago. Neither is inside the 2 h settle window.
select pg_temp.shift(8160, array[6]);
select pg_temp.shift(7740, array[7]);
select pg_temp.chk('a print 30 s old settles the 5 due positions and enters k5',
         pg_temp.j(v) ->> 'settled' = '5' and pg_temp.j(v) ->> 'entered' = '1' and pg_temp.j(v) ->> 'settle_errors' = '0', v)
  from (select pg_temp.ingest_at(pg_temp.t0() - interval '30 seconds', pg_temp.rates_eur('0.92')) v) s;
select pg_temp.chk('win: EUR-USD 1.08550 -> 1.08696, pays 659,000 + 39,540',
         (p).status = 'settled' and (p).result = 'win' and (p).settle_price::text = '1.08696' and (p).payout_cents = 698540
         and pg_temp.bills(1) = 'forex_margin -659000 pnl 0, fee -659 pnl -659, forex_close 698540 pnl 39540', pg_temp.bills(1))
  from (select pg_temp.pos(1) p) s;
select pg_temp.chk('loss: pays 0, books -premium', (p).result = 'loss' and (p).payout_cents = 0
         and pg_temp.bills(2) = 'forex_margin -659000 pnl 0, fee -659 pnl -659, forex_close 0 pnl -659000', pg_temp.bills(2))
  from (select pg_temp.pos(2) p) s;
select pg_temp.chk('draw: USD-JPY unchanged, premium refunded, fee kept', (p).result = 'draw' and (p).payout_cents = 659000
         and pg_temp.bills(3) = 'forex_margin -659000 pnl 0, fee -659 pnl -659, forex_refund 659000 pnl 0', pg_temp.bills(3))
  from (select pg_temp.pos(3) p) s;
select pg_temp.chk('k4 wins from its own entry (1.07527 -> 1.08696)', (pg_temp.pos(4)).result = 'win' and (pg_temp.pos(4)).payout_cents = 5194,
                   (pg_temp.pos(4)).result::text);
select pg_temp.chk('settlement pays a suspended account (D wins 49.00 + 2.94)',
         (pg_temp.pos(8)).payout_cents = 5194 and pg_temp.wallet('D') = 100000 - 4905 + 5194, pg_temp.wallet('D')::text);
select pg_temp.chk('settled at the first print with ts >= expires_at and ts > entry_price_at',
         bool_and(p.settle_price_at = (select min(f.ts) from public.fx_prices f where f.instrument_id = p.instrument_id
                                         and f.ts >= p.expires_at and f.ts > p.entry_price_at)), count(*)::text)
  from public.fx_positions p where p.status = 'settled';
select pg_temp.chk('k5 entered at the settle print and is not settled by it',
         (p).status = 'open' and (p).entry_price_at = pg_temp.t0() - interval '30 seconds' and (p).expires_at = (p).entry_price_at + interval '1 hour', null)
  from (select pg_temp.pos(5) p) s;
select pg_temp.chk('late and near void (outside the 2 h window) stay open',
         (pg_temp.pos(6)).status = 'open' and (pg_temp.pos(7)).status = 'open', null);
select pg_temp.chk('a newer price settles nothing twice', pg_temp.j(v) ->> 'settled' = '0' and pg_temp.j(v) ->> 'entered' = '0', v)
  from (select pg_temp.ingest_at(pg_temp.t0() - interval '10 seconds') v) s;

-- Comparison at price_decimals: an unrounded NZD-USD entry print 0.598361 and the settle print 0.59836
-- are equal at 5 decimals, a draw. The entry print is the first one at or after created_at + 5 min.
select pg_temp.chk('open NZD-USD', pg_temp.open('A', 'NZD-USD', 'rise', 3600, 4900, 12) ~ '^[0-9a-f-]{36}$', null);
select pg_temp.created(pg_temp.t0() - interval '2 hours', array[12]);
insert into public.fx_prices (instrument_id, ts, price, source) values ('NZD-USD', pg_temp.t0() - interval '115 minutes', 0.598361, 'oxr');
select pg_temp.chk('one table enters and settles the overdue NZD-USD position', pg_temp.j(v) ->> 'entered' = '1' and pg_temp.j(v) ->> 'settled' = '1', v)
  from (select pg_temp.ingest_at(pg_temp.t0()) v) s;
select pg_temp.chk('0.598361 vs 0.59836 at 5 decimals is a draw', (p).entry_price::text = '0.598361' and (p).result = 'draw'
         and (p).payout_cents = 4900, (p).result::text)
  from (select pg_temp.pos(12) p) s;

-- Pending void: created_at + 2 h 20 min passed (k10, by 1 s) or reached exactly (k11).
update public.fx_positions set created_at = now() - interval '2 hours 20 minutes 1 second' where client_request_id = pg_temp.k(10);
update public.fx_positions set created_at = now() - interval '2 hours 20 minutes' where client_request_id = pg_temp.k(11);
select pg_temp.chk('void job: 2 voided (late open, pending past 2 h 20 min)', private.void_stale_fx() = 2, null);
select pg_temp.chk('open void refunds premium + fee, refund pnl +fee, pnl sum 0', (p).status = 'void' and (p).payout_cents = 4905
         and (p).entry_price is not null and pg_temp.bills(6) = 'forex_margin -4900 pnl 0, fee -5 pnl -5, forex_refund 4905 pnl 5', pg_temp.bills(6))
  from (select pg_temp.pos(6) p) s;
select pg_temp.chk('pending void refunds premium + fee, refund pnl +fee, no entry', (p).status = 'void' and (p).payout_cents = 4905
         and (p).entry_price is null and (p).expires_at is null
         and pg_temp.bills(10) = 'forex_margin -4900 pnl 0, fee -5 pnl -5, forex_refund 4905 pnl 5', pg_temp.bills(10))
  from (select pg_temp.pos(10) p) s;
select pg_temp.chk('near void (2 h 10 min past expiry) and pending at exactly 2 h 20 min are not voided',
         (pg_temp.pos(7)).status = 'open' and (pg_temp.pos(11)).status = 'pending', null);
select pg_temp.chk('void job again: nothing left', private.void_stale_fx() = 0, null);

select pg_temp.chk('ledger identity on every exit (win, loss, draw, open void, pending void): sum(pnl) = payout - premium - fee',
         count(*) = 8 and bool_and((select sum(l.pnl_cents) from public.ledger l where l.ref_type = 'forex_position' and l.ref_id = p.id)
                                   = p.payout_cents - p.premium_cents - p.fee_cents)
         and count(*) filter (where p.status = 'void' and p.entry_price is null) = 1
         and count(*) filter (where p.status = 'void' and p.entry_price is not null) = 1, count(*)::text)
  from public.fx_positions p where p.status in ('settled', 'void');
select pg_temp.chk('each position: one premium, one fee, one close row when closed, none while pending or open',
         bool_and((select count(*) from public.ledger l where l.ref_id = p.id and l.kind = 'forex_margin' and l.delta_cents = -p.premium_cents) = 1
              and (select count(*) from public.ledger l where l.ref_id = p.id and l.kind = 'fee' and l.delta_cents = -p.fee_cents) = 1
              and (select count(*) from public.ledger l where l.ref_id = p.id and l.kind in ('forex_close', 'forex_refund'))
                  = case when p.status in ('pending', 'open') then 0 else 1 end), count(*)::text)
  from public.fx_positions p;
select pg_temp.chk('forex wallets reconcile with the ledger', bool_and(w.available_cents =
         (select sum(l.delta_cents) from public.ledger l where l.wallet_id = w.id)), null)
  from public.wallets w where w.user_id in (pg_temp.u('A'), pg_temp.u('C'), pg_temp.u('D')) and w.account = 'forex';
select pg_temp.chk('CHECK: void without settled_at is refused', v ~ 'fx_positions_status_check', v)
  from (select pg_temp.try(format('update public.fx_positions set status = %L, payout_cents = premium_cents + fee_cents where id = %L', 'void', (pg_temp.pos(7)).id)) v) s;
select pg_temp.chk('CHECK: settled without settle_price is refused', v ~ 'fx_positions_status_check', v)
  from (select pg_temp.try(format('update public.fx_positions set status = %L, result = %L, settle_price_at = expires_at, payout_cents = 0, settled_at = now() where id = %L',
                                  'settled', 'loss', (pg_temp.pos(7)).id)) v) s;
select pg_temp.chk('CHECK: open without an entry is refused', v ~ 'fx_positions_status_check', v)
  from (select pg_temp.try(format('update public.fx_positions set status = %L where id = %L', 'open', (pg_temp.pos(11)).id)) v) s;
select pg_temp.chk('CHECK: pending with an entry is refused', v ~ 'fx_positions_status_check', v)
  from (select pg_temp.try(format('update public.fx_positions set entry_price = 1, entry_price_at = created_at + interval %L, expires_at = created_at + interval %L where id = %L',
                                  '5 minutes', '65 minutes', (pg_temp.pos(11)).id)) v) s;
select pg_temp.chk('CHECK: entry price without entry time is refused', v ~ 'fx_positions_entry_check', v)
  from (select pg_temp.try(format('update public.fx_positions set entry_price_at = null where id = %L', (pg_temp.pos(5)).id)) v) s;
select pg_temp.chk('CHECK: entry print before created_at + 5 min is refused', v ~ 'fx_positions_entry_check', v)
  from (select pg_temp.try(format('update public.fx_positions set entry_price_at = created_at + interval %L, expires_at = created_at + interval %L where id = %L',
                                  '4 minutes 59 seconds', '64 minutes 59 seconds', (pg_temp.pos(5)).id)) v) s;
select pg_temp.chk('CHECK: expiry other than entry + duration is refused', v ~ 'fx_positions_entry_check', v)
  from (select pg_temp.try(format('update public.fx_positions set expires_at = expires_at + interval %L where id = %L', '1 second', (pg_temp.pos(5)).id)) v) s;
select pg_temp.chk('CHECK: pending void before created_at + 2 h 20 min is refused', v ~ 'fx_positions_status_check', v)
  from (select pg_temp.try(format('update public.fx_positions set status = %L, payout_cents = premium_cents + fee_cents, settled_at = now() where id = %L',
                                  'void', (pg_temp.pos(11)).id)) v) s;
select pg_temp.chk('only forex wallets moved', (select count(*) from public.ledger l where l.user_id in (pg_temp.u('A'), pg_temp.u('D'))
         and l.account <> 'forex') = 0, null);
SQL
;;
t4) cat <<'SQL'
-- T4 refusals: feed guard, market hours, idempotency, funds and arguments.
-- The payout figures below assume 600 / 10 bps and a 49.00 minimum (the live 30 s Options row at apply time).
-- Closure at open: refused when now + 65 min (ENTRY_WAIT_MAX) + duration + 70 min (SETTLE_MARGIN) is after
-- the next closure start; for 1 h the last open is 13:45:00 New York before a 17:00 closure.
update public.fx_periods set profit_rate_bps = 600, fee_bps = 10, min_premium_cents = 4900, enabled = true where duration_s = 3600;
select pg_temp.clock('2026-11-04 10:00:00 America/New_York');
select pg_temp.ingest(interval '71 minutes');
select pg_temp.chk('newest print 71 min old -> PRICE_STALE', v ~ 'PRICE_STALE', v) from (select pg_temp.open('A', 'EUR-USD', 'rise', 3600, 4900, 1) v) s;
select pg_temp.ingest(interval '69 minutes');
select pg_temp.chk('newest print 69 min old -> opens', v ~ '^[0-9a-f-]{36}$', v) from (select pg_temp.open('A', 'EUR-USD', 'rise', 3600, 4900, 1) v) s;
insert into public.fx_prices (instrument_id, ts, price, source) values ('USD-JPY', now() + interval '1 minute', 152.345, 'oxr');
select pg_temp.chk('newest print in the future -> PRICE_STALE', v ~ 'PRICE_STALE', v) from (select pg_temp.open('A', 'USD-JPY', 'rise', 3600, 4900, 2) v) s;

select pg_temp.clock('2026-11-07 12:00:00 America/New_York');
select pg_temp.chk('Saturday: fx -> MARKET_CLOSED (no detail)', v ~ 'MARKET_CLOSED' and v !~ 'detail', v) from (select pg_temp.open('A', 'EUR-USD', 'rise', 3600, 4900, 3) v) s;
select pg_temp.chk('Saturday: metal -> MARKET_CLOSED', v ~ 'MARKET_CLOSED', v) from (select pg_temp.open('A', 'XAU-USD', 'rise', 3600, 4900, 3) v) s;
select pg_temp.clock('2026-11-01 16:30:00 America/New_York');
select pg_temp.chk('Sunday 16:30 (DST end day): fx closed', v ~ 'MARKET_CLOSED', v) from (select pg_temp.open('A', 'EUR-USD', 'rise', 3600, 4900, 4) v) s;
select pg_temp.clock('2026-11-01 17:30:00 America/New_York');
select pg_temp.chk('Sunday 17:30: fx opens', v ~ '^[0-9a-f-]{36}$', v) from (select pg_temp.open('A', 'EUR-USD', 'rise', 3600, 4900, 4) v) s;
select pg_temp.chk('Sunday 17:30: metal still closed', v ~ 'MARKET_CLOSED', v) from (select pg_temp.open('A', 'XAU-USD', 'rise', 3600, 4900, 5) v) s;
select pg_temp.clock('2026-11-06 13:45:00 America/New_York');
select pg_temp.chk('Friday 13:45:00 + 65 min + 1 h + 70 min = 17:00: fx opens', v ~ '^[0-9a-f-]{36}$', v) from (select pg_temp.open('A', 'EUR-USD', 'rise', 3600, 4900, 6) v) s;
select pg_temp.clock('2026-11-06 13:45:01 America/New_York');
select pg_temp.chk('Friday 13:45:01: fx -> MARKET_CLOSED closes_before_expiry', v ~ 'MARKET_CLOSED detail=closes_before_expiry', v)
  from (select pg_temp.open('A', 'EUR-USD', 'rise', 3600, 4900, 7) v) s;
select pg_temp.clock('2026-11-04 13:45:00 America/New_York');
select pg_temp.chk('Wednesday 13:45:00: metal opens before the daily break', v ~ '^[0-9a-f-]{36}$', v) from (select pg_temp.open('A', 'XAU-USD', 'rise', 3600, 4900, 8) v) s;
select pg_temp.clock('2026-11-04 13:45:01 America/New_York');
select pg_temp.chk('Wednesday 13:45:01: metal -> closes_before_expiry', v ~ 'MARKET_CLOSED detail=closes_before_expiry', v)
  from (select pg_temp.open('A', 'XAU-USD', 'rise', 3600, 4900, 9) v) s;
select pg_temp.chk('Wednesday 13:45:01: fx opens', v ~ '^[0-9a-f-]{36}$', v) from (select pg_temp.open('A', 'EUR-USD', 'rise', 3600, 4900, 9) v) s;
select pg_temp.clock('2026-11-04 17:30:00 America/New_York');
select pg_temp.chk('Wednesday 17:30: metal in the daily break -> MARKET_CLOSED', v ~ 'MARKET_CLOSED' and v !~ 'detail', v)
  from (select pg_temp.open('A', 'XAG-USD', 'rise', 3600, 4900, 10) v) s;
select pg_temp.chk('Wednesday 17:30: fx opens', v ~ '^[0-9a-f-]{36}$', v) from (select pg_temp.open('A', 'EUR-USD', 'rise', 3600, 4900, 10) v) s;

-- The boundary in UTC on each side of both DST dates (2026-11-01 ends EDT, 2027-03-14 starts it):
-- 17:00 New York is 21:00 UTC in EDT and 22:00 UTC in EST, so the last 1 h open is 17:45 or 18:45 UTC.
select pg_temp.chk(format('%s %s -> %s', c, a, case when ok then 'opens' else 'closes_before_expiry' end),
         case when ok then v ~ '^[0-9a-f-]{36}$' else v ~ 'MARKET_CLOSED detail=closes_before_expiry' end, v)
  from (values
    ('fx',    '2026-10-30 17:45:00+00', true,  30), ('fx',    '2026-10-30 17:45:01+00', false, 31),   -- EDT Friday
    ('fx',    '2026-11-06 18:45:00+00', true,  32), ('fx',    '2026-11-06 18:45:01+00', false, 33),   -- EST Friday after the DST end
    ('fx',    '2027-03-12 18:45:00+00', true,  34), ('fx',    '2027-03-12 18:45:01+00', false, 35),   -- EST Friday before the DST start
    ('fx',    '2027-03-19 17:45:00+00', true,  36), ('fx',    '2027-03-19 17:45:01+00', false, 37),   -- EDT Friday after it
    ('metal', '2026-10-30 17:45:00+00', true,  40), ('metal', '2026-10-30 17:45:01+00', false, 41),   -- EDT Friday
    ('metal', '2026-11-02 18:45:00+00', true,  38), ('metal', '2026-11-02 18:45:01+00', false, 39),   -- EST Monday after the DST end
    ('metal', '2027-03-11 18:45:00+00', true,  44), ('metal', '2027-03-11 18:45:01+00', false, 45),   -- EST Thursday before the DST start
    ('metal', '2027-03-15 17:45:00+00', true,  42), ('metal', '2027-03-15 17:45:01+00', false, 43)    -- EDT Monday after it
  ) t(c, a, ok, k),
  lateral (select pg_temp.clock(t.a::timestamptz) x) clk,
  -- o reads clk.x, so each open runs after its own row's clock is set.
  lateral (select clk.x, pg_temp.open('A', case t.c when 'fx' then 'EUR-USD' else 'XAU-USD' end, 'rise', 3600, 4900, t.k) v) o
 order by t.k;
-- On both DST dates the Sunday reopen accepts an open at once; one second before it is closed.
select pg_temp.chk(format('%s %s -> %s', c, a, case when ok then 'opens' else 'MARKET_CLOSED' end),
         case when ok then v ~ '^[0-9a-f-]{36}$' else v ~ 'MARKET_CLOSED' and v !~ 'detail' end, v)
  from (values
    ('fx',    '2026-11-01 21:59:59+00', false, 46), ('fx',    '2026-11-01 22:00:00+00', true, 46),   -- 17:00 EST
    ('metal', '2026-11-01 22:59:59+00', false, 47), ('metal', '2026-11-01 23:00:00+00', true, 47),   -- 18:00 EST
    ('fx',    '2027-03-14 20:59:59+00', false, 48), ('fx',    '2027-03-14 21:00:00+00', true, 48),   -- 17:00 EDT
    ('metal', '2027-03-14 21:59:59+00', false, 49), ('metal', '2027-03-14 22:00:00+00', true, 49)    -- 18:00 EDT
  ) t(c, a, ok, k),
  lateral (select pg_temp.clock(t.a::timestamptz) x) clk,
  -- o reads clk.x, so each open runs after its own row's clock is set.
  lateral (select clk.x, pg_temp.open('A', case t.c when 'fx' then 'EUR-USD' else 'XAU-USD' end, 'rise', 3600, 4900, t.k) v) o
 order by t.a::timestamptz;
-- The duration counts: a 2 h period's last Friday open is 12:45:00 New York.
update public.fx_periods set profit_rate_bps = 700, enabled = true where duration_s = 7200;
select pg_temp.clock('2026-11-06 12:45:00 America/New_York');
select pg_temp.chk('2 h period, Friday 12:45:00: fx opens', v ~ '^[0-9a-f-]{36}$', v) from (select pg_temp.open('A', 'EUR-USD', 'rise', 7200, 4900, 51) v) s;
select pg_temp.clock('2026-11-06 12:45:01 America/New_York');
select pg_temp.chk('2 h period, Friday 12:45:01: fx -> closes_before_expiry', v ~ 'MARKET_CLOSED detail=closes_before_expiry', v)
  from (select pg_temp.open('A', 'EUR-USD', 'rise', 7200, 4900, 52) v) s;
update public.fx_periods set profit_rate_bps = 0, enabled = false where duration_s = 7200;

select pg_temp.clock('2026-11-04 10:00:00 America/New_York');
select pg_temp.chk('replay with the same key and parameters returns the same position',
         pg_temp.open('A', 'EUR-USD', 'rise', 3600, 4900, 1) = (pg_temp.pos(1)).id::text, null);
select pg_temp.chk('same key, other premium -> IDEMPOTENCY_CONFLICT', v ~ 'IDEMPOTENCY_CONFLICT', v) from (select pg_temp.open('A', 'EUR-USD', 'rise', 3600, 5000, 1) v) s;
select pg_temp.chk('same key, other direction -> IDEMPOTENCY_CONFLICT', v ~ 'IDEMPOTENCY_CONFLICT', v) from (select pg_temp.open('A', 'EUR-USD', 'fall', 3600, 4900, 1) v) s;
update public.fx_periods set enabled = false where duration_s = 3600;
select pg_temp.chk('replay still returns the position after the period is disabled',
         pg_temp.open('A', 'EUR-USD', 'rise', 3600, 4900, 1) = (pg_temp.pos(1)).id::text, null);
select pg_temp.chk('new key on the disabled period -> PERIOD_DISABLED', v ~ 'PERIOD_DISABLED', v) from (select pg_temp.open('A', 'EUR-USD', 'rise', 3600, 4900, 11) v) s;
update public.fx_periods set enabled = true where duration_s = 3600;
select pg_temp.chk('replays debited once: one premium and one fee row for the key',
         (select count(*) from public.ledger l where l.ref_id = (pg_temp.pos(1)).id) = 2, null);

select pg_temp.chk('C has 49.00: premium 49.00 + fee 0.05 -> INSUFFICIENT_FUNDS', v ~ 'INSUFFICIENT_FUNDS detail=available=4900 required=4905', v)
  from (select pg_temp.open('C', 'EUR-USD', 'rise', 3600, 4900, 20) v) s;
select pg_temp.chk('C: nothing written', pg_temp.wallet('C') = 4900 and (select count(*) from public.fx_positions where user_id = pg_temp.u('C')) = 0
         and (select count(*) from public.ledger where user_id = pg_temp.u('C')) = 1, null);
select pg_temp.chk('premium 48.99 -> BELOW_MIN_PREMIUM min_cents=4900', v ~ 'BELOW_MIN_PREMIUM detail=min_cents=4900', v) from (select pg_temp.open('A', 'EUR-USD', 'rise', 3600, 4899, 21) v) s;
select pg_temp.chk('7200 s (seeded disabled) -> PERIOD_DISABLED', v ~ 'PERIOD_DISABLED', v) from (select pg_temp.open('A', 'EUR-USD', 'rise', 7200, 4900, 22) v) s;
select pg_temp.chk('1800 s -> PERIOD_NOT_FOUND', v ~ 'PERIOD_NOT_FOUND', v) from (select pg_temp.open('A', 'EUR-USD', 'rise', 1800, 4900, 23) v) s;
select pg_temp.chk('EUR-CHF (seeded disabled) -> MARKET_DISABLED', v ~ 'MARKET_DISABLED', v) from (select pg_temp.open('A', 'EUR-CHF', 'rise', 3600, 4900, 24) v) s;
select pg_temp.chk('BTC-USDT is not a Forex instrument -> MARKET_NOT_FOUND', v ~ 'MARKET_NOT_FOUND', v) from (select pg_temp.open('A', 'BTC-USDT', 'rise', 3600, 4900, 25) v) s;
select pg_temp.chk('premium above the cap -> INVALID_AMOUNT', v ~ 'INVALID_AMOUNT', v) from (select pg_temp.open('A', 'EUR-USD', 'rise', 3600, 100000000001, 26) v) s;
select pg_temp.chk('no key -> INVALID_ARGUMENT', v ~ 'INVALID_ARGUMENT', v)
  from (select pg_temp.as_user(pg_temp.u('A'), $q$select public.open_fx_position('EUR-USD', 'rise', 3600, 4900, null)$q$) v) s;
select pg_temp.chk('no user -> UNAUTHENTICATED', v ~ 'UNAUTHENTICATED', v)
  from (select pg_temp.as_user(null, $q$select public.open_fx_position('EUR-USD', 'rise', 3600, 4900, gen_random_uuid())$q$) v) s;
select pg_temp.chk('A: positions only from the successful opens, all pending',
         (select array_agg(right(client_request_id::text, 2)::integer order by client_request_id) from public.fx_positions where user_id = pg_temp.u('A'))
         = array[1, 4, 6, 8, 9, 10, 30, 32, 34, 36, 38, 40, 42, 44, 46, 47, 48, 49, 51]
         and (select bool_and(status = 'pending') from public.fx_positions), null);
select pg_temp.chk('A: wallet = 30,000.00 - 19 x 49.05', pg_temp.wallet('A') = 3000000 - 19 * 4905, pg_temp.wallet('A')::text);
SQL
;;
t5) cat <<'SQL'
-- T5 fx_periods: the minimum premium floor CHECK and admin_set_fx_period.
select pg_temp.chk('seed: 3600 enabled with the 30 s Options rate, fee and minimum; 7200 and 14400 disabled',
         (select jsonb_agg(jsonb_build_array(duration_s, profit_rate_bps, fee_bps, min_premium_cents, enabled) order by duration_s) from public.fx_periods)
         = (select jsonb_build_array(jsonb_build_array(3600, profit_rate_bps, fee_bps, min_premium_cents, true),
                                     jsonb_build_array(7200, 0, fee_bps, min_premium_cents, false),
                                     jsonb_build_array(14400, 0, fee_bps, min_premium_cents, false))
              from public.option_periods where duration_s = 30),
         (select jsonb_agg(jsonb_build_array(duration_s, profit_rate_bps, fee_bps, min_premium_cents, enabled) order by duration_s)::text from public.fx_periods));
update public.fx_periods set profit_rate_bps = 600, fee_bps = 10, min_premium_cents = 4900 where duration_s = 3600;
select pg_temp.chk('enabled at 600 / 10 bps with minimum 33 cents -> floor CHECK', v ~ 'fx_periods_min_premium_floor', v)
  from (select pg_temp.try('update public.fx_periods set min_premium_cents = 33 where duration_s = 3600') v) s;
select pg_temp.chk('minimum 34 cents passes the floor', pg_temp.try('update public.fx_periods set min_premium_cents = 34 where duration_s = 3600') = 'ok', null);
select pg_temp.chk('a disabled period is exempt from the floor', pg_temp.try('update public.fx_periods set min_premium_cents = 1 where duration_s = 7200') = 'ok', null);
select pg_temp.chk('rate not above the fee can never be enabled', v ~ 'fx_periods_min_premium_floor', v)
  from (select pg_temp.try('update public.fx_periods set profit_rate_bps = 10, min_premium_cents = 1000000 where duration_s = 3600') v) s;
update public.fx_periods set min_premium_cents = 4900 where duration_s in (3600, 7200);

select pg_temp.chk('admin enables 7200 at 700 bps', v = '(7200,700,10,4900,t)', v)
  from (select pg_temp.as_role('authenticated', pg_temp.u('B'), 'admin',
    $q$select (r.duration_s, r.profit_rate_bps, r.fee_bps, r.min_premium_cents, r.enabled)::text from public.admin_set_fx_period(7200, 700, 10, 4900, true) r$q$) v) s;
select pg_temp.chk('one set_fx_period audit row by the admin', (select count(*) from public.admin_audit_log where admin_id = pg_temp.u('B') and action = 'set_fx_period'
         and payload ->> 'duration_s' = '7200') = 1, null);
select pg_temp.chk('plain user -> FORBIDDEN', v ~ 'FORBIDDEN', v)
  from (select pg_temp.as_role('authenticated', pg_temp.u('C'), 'user', 'select public.admin_set_fx_period(7200, 800, 10, 4900, true)') v) s;
select pg_temp.chk('admin claim without an admin row -> FORBIDDEN', v ~ 'FORBIDDEN', v)
  from (select pg_temp.as_role('authenticated', pg_temp.u('C'), 'admin', 'select public.admin_set_fx_period(7200, 800, 10, 4900, true)') v) s;
select pg_temp.chk('admin row without the claim -> FORBIDDEN', v ~ 'FORBIDDEN', v)
  from (select pg_temp.as_role('authenticated', pg_temp.u('B'), 'user', 'select public.admin_set_fx_period(7200, 800, 10, 4900, true)') v) s;
select pg_temp.chk('enabled at 0 bps -> INVALID_ARGUMENT', v ~ 'INVALID_ARGUMENT', v)
  from (select pg_temp.as_role('authenticated', pg_temp.u('B'), 'admin', 'select public.admin_set_fx_period(7200, 0, 10, 4900, true)') v) s;
select pg_temp.chk('1800 s -> PERIOD_NOT_FOUND', v ~ 'PERIOD_NOT_FOUND', v)
  from (select pg_temp.as_role('authenticated', pg_temp.u('B'), 'admin', 'select public.admin_set_fx_period(1800, 700, 10, 4900, true)') v) s;
select pg_temp.chk('minimum 33 cents enabled through the RPC -> floor CHECK', v ~ 'fx_periods_min_premium_floor', v)
  from (select pg_temp.as_role('authenticated', pg_temp.u('B'), 'admin', 'select public.admin_set_fx_period(3600, 600, 10, 33, true)') v) s;
select pg_temp.chk('refused admin calls changed nothing', (select profit_rate_bps from public.fx_periods where duration_s = 7200) = 700
         and (select count(*) from public.admin_audit_log where admin_id = pg_temp.u('B')) = 1, null);
select pg_temp.chk('option_periods untouched by the admin RPC', (select count(*) from public.admin_audit_log where action = 'set_option_period'
         and admin_id = pg_temp.u('B')) = 0, null);
SQL
;;
t6) cat <<'SQL'
-- T6 RLS, grants and function hygiene. The EXECUTE checks read the catalog before
-- pg_temp.clock replaces the market hours functions.
select pg_temp.chk(format('EXECUTE %s for %s = %s', f, r, e), has_function_privilege(r, f, 'execute') = e,
                   has_function_privilege(r, f, 'execute')::text)
  from (values
    ('private.fx_is_closed(public.fx_class, timestamptz)', 'anon', false), ('private.fx_is_closed(public.fx_class, timestamptz)', 'authenticated', false),
    ('private.fx_next_close(public.fx_class, timestamptz)', 'anon', false), ('private.fx_next_close(public.fx_class, timestamptz)', 'authenticated', false),
    ('private.settle_fx(text, numeric, timestamptz)', 'anon', false), ('private.settle_fx(text, numeric, timestamptz)', 'authenticated', false),
    ('private.void_stale_fx()', 'anon', false), ('private.void_stale_fx()', 'authenticated', false),
    ('private.fx_entry_guard()', 'anon', false), ('private.fx_entry_guard()', 'authenticated', false),
    ('private.fx_entry_wait_max()', 'anon', false), ('private.fx_entry_wait_max()', 'authenticated', false),
    ('public.ingest_fx_rates(text)', 'anon', false), ('public.ingest_fx_rates(text)', 'authenticated', false),
    ('public.ingest_fx_rates(text)', 'service_role', true),
    ('public.open_fx_position(text, public.option_direction, integer, bigint, uuid)', 'anon', false),
    ('public.open_fx_position(text, public.option_direction, integer, bigint, uuid)', 'authenticated', true),
    ('public.admin_set_fx_period(integer, integer, integer, bigint, boolean)', 'anon', false),
    ('public.admin_set_fx_period(integer, integer, integer, bigint, boolean)', 'authenticated', true)
  ) t(f, r, e);
select pg_temp.clock('2026-11-04 10:00:00 America/New_York');
select pg_temp.ingest(interval '5 minutes');
select pg_temp.open('A', 'EUR-USD', 'rise', 3600, 4900, 1);
select pg_temp.chk('A reads its own position, pending', pg_temp.as_user(pg_temp.u('A'), 'select status::text from public.fx_positions') = 'pending', null);
select pg_temp.chk('D reads none of them', pg_temp.as_user(pg_temp.u('D'), 'select count(*) from public.fx_positions') = '0', null);
select pg_temp.chk('authenticated reads the 13 enabled instruments', pg_temp.as_user(pg_temp.u('D'), 'select count(*) from public.fx_instruments') = '13', null);
select pg_temp.chk('authenticated reads the 3 periods', pg_temp.as_user(pg_temp.u('D'), 'select count(*) from public.fx_periods') = '3', null);
select pg_temp.chk('authenticated reads prices', pg_temp.as_user(pg_temp.u('D'), 'select count(*) >= 17 from public.fx_prices') = 'true', null);
select pg_temp.chk('anon: ' || q, pg_temp.as_role('anon', null, null, q) ~ 'permission denied', pg_temp.as_role('anon', null, null, q))
  from unnest(array['select count(*) from public.fx_positions', 'select count(*) from public.fx_instruments',
                    'select count(*) from public.fx_prices', 'select count(*) from public.fx_periods',
                    $q$select public.open_fx_position('EUR-USD', 'rise', 3600, 4900, gen_random_uuid())$q$,
                    $q$select public.ingest_fx_rates('{}')$q$,
                    $q$select public.admin_set_fx_period(3600, 600, 10, 4900, true)$q$]) q;
select pg_temp.chk('authenticated: ' || q, pg_temp.as_user(pg_temp.u('A'), q) ~ 'permission denied', pg_temp.as_user(pg_temp.u('A'), q))
  from unnest(array[
    $q$insert into public.fx_positions (user_id, instrument_id, direction, duration_s, premium_cents, fee_cents, profit_rate_bps, entry_price, entry_price_at, created_at, expires_at, client_request_id) values (auth.uid(), 'EUR-USD', 'rise', 3600, 4900, 5, 600, 1, now(), now(), now() + interval '1 hour', gen_random_uuid())$q$,
    $q$update public.fx_positions set status = 'void'$q$,
    $q$insert into public.fx_prices (instrument_id, ts, price, source) values ('EUR-USD', now(), 2, 'oxr')$q$,
    $q$update public.fx_periods set profit_rate_bps = 90000$q$,
    $q$update public.fx_instruments set enabled = true$q$,
    $q$select public.ingest_fx_rates('{}')$q$,
    $q$select private.settle_fx('EUR-USD', 1, now())$q$,
    $q$select private.void_stale_fx()$q$]) q;
select pg_temp.chk('open_fx_position takes no price',
         (select pg_get_function_identity_arguments(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'open_fx_position')
         = 'p_instrument_id text, p_direction option_direction, p_duration_s integer, p_premium_cents bigint, p_client_request_id uuid', null);
select pg_temp.chk('every new function sets search_path to empty', count(*) = 9 and bool_and(p.proconfig @> array['search_path=""']), count(*)::text)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where (n.nspname, p.proname) in (('private','fx_is_closed_real'), ('private','fx_next_close_real'), ('private','settle_fx'), ('private','void_stale_fx'),
                                  ('private','fx_entry_guard'), ('private','fx_entry_wait_max'),
                                  ('public','open_fx_position'), ('public','ingest_fx_rates'), ('public','admin_set_fx_period'));
select pg_temp.chk('the money functions are SECURITY DEFINER', bool_and(p.prosecdef) and count(*) = 5, count(*)::text)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where (n.nspname, p.proname) in (('private','settle_fx'), ('private','void_stale_fx'), ('public','open_fx_position'),
                                  ('public','ingest_fx_rates'), ('public','admin_set_fx_period'));
select pg_temp.chk('fx_positions and fx_prices are in the Realtime publication',
         (select count(*) from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'
            and tablename in ('fx_positions', 'fx_prices')) = 2, null);
select pg_temp.chk('fx_positions.status is fx_position_status; options_positions.status is still option_status',
         (select format_type(atttypid, null) from pg_attribute where attrelid = 'public.fx_positions'::regclass and attname = 'status') = 'fx_position_status'
         and (select format_type(atttypid, null) from pg_attribute where attrelid = 'public.options_positions'::regclass and attname = 'status') = 'option_status'
         and (select enum_range(null::public.option_status)::text) = '{open,settled,void}', null);
select pg_temp.chk('the void job runs every minute', (select schedule from cron.job where jobname = 'aureonx-fx-void') = '* * * * *', null);
select pg_temp.chk('RLS on all four tables', (select bool_and(relrowsecurity) from pg_class
         where oid in ('public.fx_instruments'::regclass, 'public.fx_periods'::regclass, 'public.fx_prices'::regclass, 'public.fx_positions'::regclass)), null);
SQL
;;
t7) cat <<'SQL'
-- T7 one table enters more than 500 pending positions and settles more than 500 due ones.
-- Batch 1 (501) opens at T0-68m and enters at T0-63m (expires T0-3m); batch 2 (501) opens at T0-20m.
-- The table at T0-30s enters batch 2 and settles batch 1.
select pg_temp.clock('2026-11-04 10:00:00 America/New_York');
update public.fx_periods set profit_rate_bps = 600, fee_bps = 10, min_premium_cents = 4900, enabled = true where duration_s = 3600;
select private.wallet_apply((select id from public.wallets where user_id = pg_temp.u('A') and account = 'forex'),
         5000000, 0, 'admin_credit', 'admin_adjustment', gen_random_uuid(), p_memo => 'Balance adjustment');
select pg_temp.ingest_at(pg_temp.t0() - interval '69 minutes');
select pg_temp.chk('batch 1: 501 positions opened', v = '501', v)
  from (select pg_temp.as_user(pg_temp.u('A'),
    $q$select count(public.open_fx_position('EUR-USD', 'rise', 3600, 4900, gen_random_uuid())) from generate_series(1, 501)$q$) v) s;
update public.fx_positions set created_at = pg_temp.t0() - interval '68 minutes' where user_id = pg_temp.u('A') and status = 'pending';
select pg_temp.chk('one table enters all 501', pg_temp.j(v) ->> 'entered' = '501' and pg_temp.j(v) ->> 'settled' = '0', v)
  from (select pg_temp.ingest_at(pg_temp.t0() - interval '63 minutes') v) s;
select pg_temp.chk('batch 2: 501 positions opened', v = '501', v)
  from (select pg_temp.as_user(pg_temp.u('A'),
    $q$select count(public.open_fx_position('EUR-USD', 'rise', 3600, 4900, gen_random_uuid())) from generate_series(1, 501)$q$) v) s;
update public.fx_positions set created_at = pg_temp.t0() - interval '20 minutes' where user_id = pg_temp.u('A') and status = 'pending';
select pg_temp.chk('one table enters 501 and settles 501', pg_temp.j(v) ->> 'entered' = '501' and pg_temp.j(v) ->> 'settled' = '501'
         and pg_temp.j(v) ->> 'settle_errors' = '0', v)
  from (select pg_temp.ingest_at(pg_temp.t0() - interval '30 seconds', pg_temp.rates_eur('0.92')) v) s;
select pg_temp.chk('batch 1: all settled at the same price and ts', count(*) = 501 and count(distinct (settle_price, settle_price_at)) = 1, count(*)::text)
  from public.fx_positions where user_id = pg_temp.u('A') and status = 'settled';
select pg_temp.chk('batch 2: all open, entered at the T0-30s print', count(*) = 501
         and bool_and(entry_price_at = pg_temp.t0() - interval '30 seconds' and entry_price::text = '1.08696'), count(*)::text)
  from public.fx_positions where user_id = pg_temp.u('A') and status = 'open';
select pg_temp.chk('wallet: 80,000.00 - 1002 x 49.05 + 501 x 51.94', pg_temp.wallet('A') = 8000000 - 1002 * 4905 + 501 * 5194, pg_temp.wallet('A')::text);
SQL
;;
t8) cat <<'SQL'
-- T8 the entry cap: only a print with ts in [created_at + 5 min, created_at + 65 min] enters,
-- judged on the print's own ts (market hours read as Wednesday 2026-11-04 10:00 New York).
-- P0 at T0-69m. k1 EUR-USD opens at T0-134m (cap T0-69m = P0), k2 GBP-USD at T0-134m-1s
-- (P0 is 1 s past its cap), k3 USD-CHF at T0-68m (window T0-63m to T0-3m).
update public.fx_periods set profit_rate_bps = 600, fee_bps = 10, min_premium_cents = 4900, enabled = true where duration_s = 3600;
select pg_temp.clock('2026-11-04 10:00:00 America/New_York');
select pg_temp.ingest_at(pg_temp.t0() - interval '69 minutes');
select pg_temp.chk('open ' || x.l, pg_temp.open('A', x.ins, 'rise', 3600, 4900, x.k) ~ '^[0-9a-f-]{36}$', null)
  from (values ('at the cap', 'EUR-USD', 1), ('1 s past the cap', 'GBP-USD', 2), ('ingested late', 'USD-CHF', 3)) x(l, ins, k);
select pg_temp.created(pg_temp.t0() - interval '134 minutes', array[1]);
select pg_temp.created(pg_temp.t0() - interval '134 minutes 1 second', array[2]);
select pg_temp.created(pg_temp.t0() - interval '68 minutes', array[3]);
select pg_temp.chk('table at T0-60m (no CHF rate) enters only k1', pg_temp.j(v) ->> 'entered' = '1', v)
  from (select pg_temp.ingest_at(pg_temp.t0() - interval '60 minutes', replace(pg_temp.rates(), '"CHF":0.861234,', '')) v) s;
select pg_temp.chk('a print at exactly created_at + 65 min enters (k1 at P0)', (p).status = 'open'
         and (p).entry_price_at = (p).created_at + interval '65 minutes' and (p).entry_price_at = pg_temp.t0() - interval '69 minutes', null)
  from (select pg_temp.pos(1) p) s;
select pg_temp.chk('a print 1 s past created_at + 65 min does not enter (k2), nor any later one', (pg_temp.pos(2)).status = 'pending', null);
select pg_temp.chk('k3 still pending (no USD-CHF print in its window yet)', (pg_temp.pos(3)).status = 'pending', null);
-- The table at T0-10m is ingested at now() = T0, 3 min after k3's cap: its ts is inside the window.
select pg_temp.chk('an in-cap print ingested after the cap still enters (k3 at T0-10m)', pg_temp.j(v) ->> 'entered' = '1', v)
  from (select pg_temp.ingest_at(pg_temp.t0() - interval '10 minutes') v) s;
select pg_temp.chk('... k3 entry at T0-10m, expires 1 h later', (p).status = 'open' and (p).entry_price_at = pg_temp.t0() - interval '10 minutes'
         and (p).expires_at = (p).entry_price_at + interval '1 hour', null)
  from (select pg_temp.pos(3) p) s;
select pg_temp.chk('k2 still pending after a later print', (pg_temp.pos(2)).status = 'pending', null);
update public.fx_positions set created_at = now() - interval '2 hours 20 minutes' where client_request_id = pg_temp.k(2);
select pg_temp.chk('k2 at exactly 2 h 20 min is not voided', private.void_stale_fx() = 0, null);
update public.fx_positions set created_at = now() - interval '2 hours 20 minutes 1 second' where client_request_id = pg_temp.k(2);
select pg_temp.chk('k2 voids past 2 h 20 min', private.void_stale_fx() = 1, null);
select pg_temp.chk('... with a full refund of premium + fee, pnl sum 0', (p).status = 'void' and (p).entry_price is null and (p).payout_cents = 4905
         and pg_temp.bills(2) = 'forex_margin -4900 pnl 0, fee -5 pnl -5, forex_refund 4905 pnl 5', pg_temp.bills(2))
  from (select pg_temp.pos(2) p) s;
select pg_temp.chk('CHECK: an entry past created_at + 65 min is refused', v ~ 'fx_positions_entry_check', v)
  from (select pg_temp.try(format('update public.fx_positions set entry_price_at = created_at + interval %L, expires_at = created_at + interval %L where id = %L',
                                  '65 minutes 1 second', '125 minutes 1 second', (pg_temp.pos(3)).id)) v) s;

-- Friday 2026-11-06: k10 opens at 13:45 New York (the last 1 h open). The 14:00 print is missing; the
-- next is 15:00, 75 min after the open. Entering there would expire 16:00 and settle into the 17:00
-- closure, so it must never enter. The scenario is built at T0 = 13:45 and then moved back 75 min
-- (positions and EUR-USD prints together), so the 15:00 print can be ingested at T0.
select pg_temp.ingest_at(pg_temp.t0() - interval '15 seconds');
select pg_temp.clock('2026-11-06 13:45:00 America/New_York');
select pg_temp.chk('Friday 13:45: fx opens', v ~ '^[0-9a-f-]{36}$', v) from (select pg_temp.open('A', 'EUR-USD', 'rise', 3600, 4900, 10) v) s;
update public.fx_positions set created_at = created_at - interval '75 minutes' where client_request_id = pg_temp.k(10);
update public.fx_prices set ts = ts - interval '75 minutes' where instrument_id = 'EUR-USD';
select pg_temp.chk('the 15:00 print (75 min after the open) enters nothing', pg_temp.j(v) ->> 'entered' = '0', v)
  from (select pg_temp.ingest_at(pg_temp.t0()) v) s;
select pg_temp.chk('... k10 stays pending', (pg_temp.pos(10)).status = 'pending' and (pg_temp.pos(10)).expires_at is null, null);
update public.fx_positions set created_at = now() - interval '2 hours 20 minutes 1 second' where client_request_id = pg_temp.k(10);
select pg_temp.chk('k10 voids with a full refund', private.void_stale_fx() = 1, null);
select pg_temp.chk('... premium + fee back, pnl sum 0', pg_temp.bills(10) = 'forex_margin -4900 pnl 0, fee -5 pnl -5, forex_refund 4905 pnl 5', pg_temp.bills(10));
select pg_temp.chk('ledger identity on every closed position', bool_and((select sum(l.pnl_cents) from public.ledger l where l.ref_id = p.id)
         = p.payout_cents - p.premium_cents - p.fee_cents) and count(*) = 3, count(*)::text)
  from public.fx_positions p where p.status in ('settled', 'void');
select pg_temp.chk('forex wallets reconcile with the ledger', bool_and(w.available_cents =
         (select sum(l.delta_cents) from public.ledger l where l.wallet_id = w.id)), null)
  from public.wallets w where w.user_id = pg_temp.u('A') and w.account = 'forex';
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
