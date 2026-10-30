#!/bin/bash
# Forex money path tests (fx tables, open_fx_position, ingest_fx_rates, settle_fx, void_stale_fx,
# admin_set_fx_period, market hours). Prints PASS/FAIL lines (no keys) and exits non-zero if any
# check fails.
# Usage: supabase/tests/forex.sh [t1 ... t7]  (Management API, write token required)
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
create function pg_temp.body(p_age interval, p_rates text, p_base text default 'USD') returns text language sql stable as
  $f$ select format('{"disclaimer":"Usage subject to terms","license":"https://openexchangerates.org/license","timestamp":%s,"base":"%s","rates":%s}',
        floor(extract(epoch from now() - p_age))::bigint, p_base, p_rates) $f$;
create function pg_temp.ingest_raw(p_body text) returns text language sql as
  $f$ select pg_temp.as_role('service_role', null, null, format('select public.ingest_fx_rates(%L)::text', p_body)) $f$;
create function pg_temp.ingest(p_age interval, p_rates text default null, p_base text default 'USD') returns text language sql as
  $f$ select pg_temp.ingest_raw(pg_temp.body(p_age, coalesce(p_rates, pg_temp.rates()), p_base)) $f$;
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
-- T3 open, settle and void (market hours read as Wednesday 2026-11-04 10:00 New York).
-- The payout figures below assume 600 / 10 bps and a 49.00 minimum (the live 30 s Options row at apply time).
update public.fx_periods set profit_rate_bps = 600, fee_bps = 10, min_premium_cents = 4900, enabled = true where duration_s = 3600;
select pg_temp.clock('2026-11-04 10:00:00 America/New_York');
select pg_temp.chk('base table ingested 5 min ago', pg_temp.j(v) ->> 'accepted' = '17', v) from (select pg_temp.ingest(interval '5 minutes') v) s;
select pg_temp.chk('open ' || x.l, pg_temp.open(x.who, x.ins, x.dir, 3600, x.prem, x.k) ~ '^[0-9a-f-]{36}$', pg_temp.open(x.who, x.ins, x.dir, 3600, x.prem, x.k))
  from (values ('win', 'A', 'EUR-USD', 'rise', 659000, 1), ('loss', 'A', 'EUR-USD', 'fall', 659000, 2),
               ('draw', 'A', 'USD-JPY', 'rise', 659000, 3), ('not expired', 'A', 'EUR-USD', 'rise', 4900, 4),
               ('late', 'A', 'EUR-USD', 'rise', 4900, 5), ('near void', 'A', 'EUR-USD', 'rise', 4900, 6),
               ('D before suspension', 'D', 'EUR-USD', 'rise', 4900, 7)) x(l, who, ins, dir, prem, k);
select pg_temp.chk('entry is the newest stored price (EUR-USD 1.08550 at its ts)',
         (pg_temp.pos(1)).entry_price::text = '1.08550'
         and (pg_temp.pos(1)).entry_price_at = (select max(ts) from public.fx_prices where instrument_id = 'EUR-USD'),
         (pg_temp.pos(1)).entry_price::text);
select pg_temp.chk('expires_at = created_at + 3600 s, created_at = now()',
         (pg_temp.pos(1)).expires_at = now() + interval '1 hour' and (pg_temp.pos(1)).created_at = now(), null);
select pg_temp.chk('659,000 premium: fee ceil(659) on top; Bills forex_margin and fee (pnl -fee)',
         (pg_temp.pos(1)).fee_cents = 659 and pg_temp.bills(1) = 'forex_margin -659000 pnl 0, fee -659 pnl -659', pg_temp.bills(1));
select pg_temp.chk('49.00 premium: fee ceil(4.9) = 5', (pg_temp.pos(4)).fee_cents = 5, (pg_temp.pos(4)).fee_cents::text);
select pg_temp.chk('A forex wallet after opens = 30,000.00 - 3 x 6,596.59 - 3 x 49.05', pg_temp.wallet('A') = 3000000 - 3 * 659659 - 3 * 4905,
                   pg_temp.wallet('A')::text);
update public.profiles set suspended_at = now(), suspension_reason = 'forex test' where id = pg_temp.u('D');
select pg_temp.chk('suspended account -> ACCOUNT_SUSPENDED, nothing written', v ~ 'ACCOUNT_SUSPENDED' and pg_temp.wallet('D') = 100000 - 4905, v)
  from (select pg_temp.open('D', 'EUR-USD', 'rise', 3600, 4900, 8) v) s;

-- Expired 100 s ago: win, loss, draw, D. Late: expired 2 h 16 min ago. Near void: expired 2 h 10 min ago.
select pg_temp.shift(3700, array[1, 2, 3, 7]);
select pg_temp.shift(3600 + 8160, array[5]);
select pg_temp.shift(3600 + 7800, array[6]);
select pg_temp.chk('a price 30 s old settles the 4 due positions only',
         pg_temp.j(v) ->> 'settled' = '4' and pg_temp.j(v) ->> 'settle_errors' = '0', v)
  from (select pg_temp.ingest(interval '30 seconds',
    '{"USD":1,"EUR":0.92,"GBP":0.771234,"JPY":152.3445,"CHF":0.861234,"CAD":1.381234,"AUD":1.521234,"NZD":1.671234,"XAU":0.000251234,"XAG":0.0301234}') v) s;
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
select pg_temp.chk('settlement pays a suspended account (D wins 49.00 + 2.94)',
         (pg_temp.pos(7)).payout_cents = 5194 and pg_temp.wallet('D') = 100000 - 4905 + 5194, pg_temp.wallet('D')::text);
select pg_temp.chk('settled at the first price with ts >= expires_at',
         (p).settle_price_at = (select min(ts) from public.fx_prices where instrument_id = 'EUR-USD' and ts >= (p).expires_at), null)
  from (select pg_temp.pos(1) p) s;
select pg_temp.chk('not expired, late (outside the 2 h window) and near void stay open',
         (pg_temp.pos(4)).status = 'open' and (pg_temp.pos(5)).status = 'open' and (pg_temp.pos(6)).status = 'open', null);
select pg_temp.chk('a newer price settles nothing twice', pg_temp.j(v) ->> 'settled' = '0', v)
  from (select pg_temp.ingest(interval '10 seconds') v) s;

-- Comparison at price_decimals: NZD-USD entry 0.598361 and settle 0.598364 are both 0.59836, a draw.
insert into public.fx_prices (instrument_id, ts, price, source) values ('NZD-USD', now(), 0.598361, 'oxr');
select pg_temp.chk('open NZD-USD at an unrounded stored price', pg_temp.open('A', 'NZD-USD', 'rise', 3600, 4900, 9) ~ '^[0-9a-f-]{36}$', null);
select pg_temp.shift(3700, array[9]);
select pg_temp.chk('settle_fx at 0.598364 -> 1 settled', private.settle_fx('NZD-USD', 0.598364, now() - interval '20 seconds') = 1, null);
select pg_temp.chk('0.598361 vs 0.598364 at 5 decimals is a draw', (pg_temp.pos(9)).result = 'draw' and (pg_temp.pos(9)).payout_cents = 4900,
                   (pg_temp.pos(9)).result::text);

select pg_temp.chk('void job: 1 voided (late)', private.void_stale_fx() = 1, null);
select pg_temp.chk('void refunds premium + fee, refund pnl +fee, pnl sum 0', (p).status = 'void' and (p).payout_cents = 4905
         and pg_temp.bills(5) = 'forex_margin -4900 pnl 0, fee -5 pnl -5, forex_refund 4905 pnl 5', pg_temp.bills(5))
  from (select pg_temp.pos(5) p) s;
select pg_temp.chk('near void (2 h 10 min past expiry) is not voided', (pg_temp.pos(6)).status = 'open', null);
select pg_temp.chk('void job again: nothing left', private.void_stale_fx() = 0, null);

select pg_temp.chk('ledger identity: per closed position sum(pnl) = payout - premium - fee',
         count(*) = 6 and bool_and((select sum(l.pnl_cents) from public.ledger l where l.ref_type = 'forex_position' and l.ref_id = p.id)
                                   = p.payout_cents - p.premium_cents - p.fee_cents), count(*)::text)
  from public.fx_positions p where p.status <> 'open';
select pg_temp.chk('each position: one premium, one fee, one close row when closed',
         bool_and((select count(*) from public.ledger l where l.ref_id = p.id and l.kind = 'forex_margin' and l.delta_cents = -p.premium_cents) = 1
              and (select count(*) from public.ledger l where l.ref_id = p.id and l.kind = 'fee' and l.delta_cents = -p.fee_cents) = 1
              and (select count(*) from public.ledger l where l.ref_id = p.id and l.kind in ('forex_close', 'forex_refund'))
                  = case when p.status = 'open' then 0 else 1 end), count(*)::text)
  from public.fx_positions p;
select pg_temp.chk('forex wallets reconcile with the ledger', bool_and(w.available_cents =
         (select sum(l.delta_cents) from public.ledger l where l.wallet_id = w.id)), null)
  from public.wallets w where w.user_id in (pg_temp.u('A'), pg_temp.u('C'), pg_temp.u('D')) and w.account = 'forex';
select pg_temp.chk('CHECK: void without settled_at is refused', v ~ 'fx_positions_check', v)
  from (select pg_temp.try(format('update public.fx_positions set status = %L, payout_cents = premium_cents + fee_cents where id = %L', 'void', (pg_temp.pos(6)).id)) v) s;
select pg_temp.chk('CHECK: settled without settle_price is refused', v ~ 'fx_positions_check', v)
  from (select pg_temp.try(format('update public.fx_positions set status = %L, result = %L, settle_price_at = expires_at, payout_cents = 0, settled_at = now() where id = %L',
                                  'settled', 'loss', (pg_temp.pos(6)).id)) v) s;
select pg_temp.chk('only forex wallets moved', (select count(*) from public.ledger l where l.user_id in (pg_temp.u('A'), pg_temp.u('D'))
         and l.account <> 'forex') = 0, null);
SQL
;;
t4) cat <<'SQL'
-- T4 refusals: price age, market hours, idempotency, funds and arguments.
-- The payout figures below assume 600 / 10 bps and a 49.00 minimum (the live 30 s Options row at apply time).
update public.fx_periods set profit_rate_bps = 600, fee_bps = 10, min_premium_cents = 4900, enabled = true where duration_s = 3600;
select pg_temp.clock('2026-11-04 10:00:00 America/New_York');
select pg_temp.ingest(interval '61 minutes');
select pg_temp.chk('newest price 61 min old -> PRICE_STALE', v ~ 'PRICE_STALE', v) from (select pg_temp.open('A', 'EUR-USD', 'rise', 3600, 4900, 1) v) s;
select pg_temp.ingest(interval '59 minutes');
select pg_temp.chk('newest price 59 min old -> opens', v ~ '^[0-9a-f-]{36}$', v) from (select pg_temp.open('A', 'EUR-USD', 'rise', 3600, 4900, 1) v) s;
insert into public.fx_prices (instrument_id, ts, price, source) values ('USD-JPY', now() + interval '1 minute', 152.345, 'oxr');
select pg_temp.chk('newest price in the future -> PRICE_STALE', v ~ 'PRICE_STALE', v) from (select pg_temp.open('A', 'USD-JPY', 'rise', 3600, 4900, 2) v) s;

select pg_temp.clock('2026-11-07 12:00:00 America/New_York');
select pg_temp.chk('Saturday: fx -> MARKET_CLOSED (no detail)', v ~ 'MARKET_CLOSED' and v !~ 'detail', v) from (select pg_temp.open('A', 'EUR-USD', 'rise', 3600, 4900, 3) v) s;
select pg_temp.chk('Saturday: metal -> MARKET_CLOSED', v ~ 'MARKET_CLOSED', v) from (select pg_temp.open('A', 'XAU-USD', 'rise', 3600, 4900, 3) v) s;
select pg_temp.clock('2026-11-01 16:30:00 America/New_York');
select pg_temp.chk('Sunday 16:30 (DST end day): fx closed', v ~ 'MARKET_CLOSED', v) from (select pg_temp.open('A', 'EUR-USD', 'rise', 3600, 4900, 4) v) s;
select pg_temp.clock('2026-11-01 17:30:00 America/New_York');
select pg_temp.chk('Sunday 17:30: fx opens', v ~ '^[0-9a-f-]{36}$', v) from (select pg_temp.open('A', 'EUR-USD', 'rise', 3600, 4900, 4) v) s;
select pg_temp.chk('Sunday 17:30: metal still closed', v ~ 'MARKET_CLOSED', v) from (select pg_temp.open('A', 'XAU-USD', 'rise', 3600, 4900, 5) v) s;
select pg_temp.clock('2026-11-06 14:49:00 America/New_York');
select pg_temp.chk('Friday 14:49 + 1 h + 70 min = 16:59: fx opens', v ~ '^[0-9a-f-]{36}$', v) from (select pg_temp.open('A', 'EUR-USD', 'rise', 3600, 4900, 6) v) s;
select pg_temp.clock('2026-11-06 14:51:00 America/New_York');
select pg_temp.chk('Friday 14:51: fx -> MARKET_CLOSED closes_before_expiry', v ~ 'MARKET_CLOSED detail=closes_before_expiry', v)
  from (select pg_temp.open('A', 'EUR-USD', 'rise', 3600, 4900, 7) v) s;
select pg_temp.clock('2026-11-04 14:49:00 America/New_York');
select pg_temp.chk('Wednesday 14:49: metal opens before the daily break', v ~ '^[0-9a-f-]{36}$', v) from (select pg_temp.open('A', 'XAU-USD', 'rise', 3600, 4900, 8) v) s;
select pg_temp.clock('2026-11-04 14:51:00 America/New_York');
select pg_temp.chk('Wednesday 14:51: metal -> closes_before_expiry', v ~ 'MARKET_CLOSED detail=closes_before_expiry', v)
  from (select pg_temp.open('A', 'XAU-USD', 'rise', 3600, 4900, 9) v) s;
select pg_temp.chk('Wednesday 14:51: fx opens', v ~ '^[0-9a-f-]{36}$', v) from (select pg_temp.open('A', 'EUR-USD', 'rise', 3600, 4900, 9) v) s;
select pg_temp.clock('2026-11-04 17:30:00 America/New_York');
select pg_temp.chk('Wednesday 17:30: metal in the daily break -> MARKET_CLOSED', v ~ 'MARKET_CLOSED' and v !~ 'detail', v)
  from (select pg_temp.open('A', 'XAG-USD', 'rise', 3600, 4900, 10) v) s;
select pg_temp.chk('Wednesday 17:30: fx opens', v ~ '^[0-9a-f-]{36}$', v) from (select pg_temp.open('A', 'EUR-USD', 'rise', 3600, 4900, 10) v) s;

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
select pg_temp.chk('A: positions only from the successful opens (keys 1, 4, 6, 8, 9, 10)',
         (select array_agg(right(client_request_id::text, 2)::integer order by client_request_id) from public.fx_positions where user_id = pg_temp.u('A'))
         = array[1, 4, 6, 8, 9, 10], null);
select pg_temp.chk('A: wallet = 30,000.00 - 6 x 49.05', pg_temp.wallet('A') = 3000000 - 6 * 4905, pg_temp.wallet('A')::text);
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
select pg_temp.chk('A reads its own position', pg_temp.as_user(pg_temp.u('A'), 'select count(*) from public.fx_positions') = '1', null);
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
select pg_temp.chk('every new function sets search_path to empty', count(*) = 7 and bool_and(p.proconfig @> array['search_path=""']), count(*)::text)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where (n.nspname, p.proname) in (('private','fx_is_closed_real'), ('private','fx_next_close_real'), ('private','settle_fx'), ('private','void_stale_fx'),
                                  ('public','open_fx_position'), ('public','ingest_fx_rates'), ('public','admin_set_fx_period'));
select pg_temp.chk('the money functions are SECURITY DEFINER', bool_and(p.prosecdef) and count(*) = 5, count(*)::text)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where (n.nspname, p.proname) in (('private','settle_fx'), ('private','void_stale_fx'), ('public','open_fx_position'),
                                  ('public','ingest_fx_rates'), ('public','admin_set_fx_period'));
select pg_temp.chk('fx_positions and fx_prices are in the Realtime publication',
         (select count(*) from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'
            and tablename in ('fx_positions', 'fx_prices')) = 2, null);
select pg_temp.chk('the void job runs every minute', (select schedule from cron.job where jobname = 'aureonx-fx-void') = '* * * * *', null);
select pg_temp.chk('RLS on all four tables', (select bool_and(relrowsecurity) from pg_class
         where oid in ('public.fx_instruments'::regclass, 'public.fx_periods'::regclass, 'public.fx_prices'::regclass, 'public.fx_positions'::regclass)), null);
SQL
;;
t7) cat <<'SQL'
-- T7 one price settles every due position of an instrument, beyond one batch of 500.
select pg_temp.clock('2026-11-04 10:00:00 America/New_York');
update public.fx_periods set profit_rate_bps = 600, fee_bps = 10, min_premium_cents = 4900, enabled = true where duration_s = 3600;
select private.wallet_apply((select id from public.wallets where user_id = pg_temp.u('A') and account = 'forex'),
         5000000, 0, 'admin_credit', 'admin_adjustment', gen_random_uuid(), p_memo => 'Balance adjustment');
select pg_temp.ingest(interval '5 minutes');
select pg_temp.chk('501 positions opened', v = '501', v)
  from (select pg_temp.as_user(pg_temp.u('A'),
    $q$select count(public.open_fx_position('EUR-USD', 'rise', 3600, 4900, gen_random_uuid())) from generate_series(1, 501)$q$) v) s;
update public.fx_positions set created_at = created_at - interval '3700 seconds', expires_at = expires_at - interval '3700 seconds',
       entry_price_at = entry_price_at - interval '3700 seconds' where user_id = pg_temp.u('A');
select pg_temp.chk('one price settles all 501', pg_temp.j(v) ->> 'settled' = '501', v)
  from (select pg_temp.ingest(interval '30 seconds',
    '{"USD":1,"EUR":0.92,"GBP":0.771234,"JPY":152.3445,"CHF":0.861234,"CAD":1.381234,"AUD":1.521234,"NZD":1.671234,"XAU":0.000251234,"XAG":0.0301234}') v) s;
select pg_temp.chk('all at the same price and ts', count(*) = 501 and count(distinct (settle_price, settle_price_at)) = 1, count(*)::text)
  from public.fx_positions where user_id = pg_temp.u('A') and status = 'settled';
select pg_temp.chk('wallet: 80,000.00 - 501 x 49.05 + 501 x 51.94', pg_temp.wallet('A') = 8000000 - 501 * 4905 + 501 * 5194, pg_temp.wallet('A')::text);
SQL
;;
*) echo "unknown step $1" >&2; return 1;;
esac
}

steps=("$@"); [ ${#steps[@]} -eq 0 ] && steps=(t1 t2 t3 t4 t5 t6 t7)
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
