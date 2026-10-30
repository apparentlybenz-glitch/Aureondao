#!/usr/bin/env bash
# Options settlement lock order (20261031110000_options_settle_lock_order.sql).
# Local only: starts a throwaway Postgres, never touches the Supabase project.
#
#   supabase/tests/options_lock_order.sh [rounds]     (default 200)
#
# Loads a minimal stub schema plus the real function text of lock_wallets,
# wallet_apply, parse_decimal, settle_options and void_stale_options from the
# migrations, then runs every check twice: with ingest_prices from
# 20261026183757_options_followups.sql (before) and from
# 20261031110000_options_settle_lock_order.sql (after).
#   race:  each round, users hold one void-eligible position and one due position
#          on one of 4 markets; ingest_prices and void_stale_options run at the
#          same time. Counts deadlocks and due positions left open.
#   >500:  1200 due positions in one market, one ingest; counts those left open.
#   same:  a fixed set of 300 positions (wins, losses, draws) settled by one
#          ingest; the positions and ledger rows must match between before and
#          after.
# Exits non-zero when "after" has a deadlock, a stranded or leftover position,
# a broken balance or a fixed set that differs from "before". "before" is
# expected to show deadlocks and 700 leftovers; how many deadlocks depends on
# timing.
#
# Needs the Postgres server binaries (PG_BIN, default `pg_config --bindir`, else
# /usr/lib/postgresql/16/bin). Run as root, it starts the server as `postgres`.
set -euo pipefail

ROUNDS=${1:-200}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
MIG=$ROOT/supabase/migrations
PG_BIN=${PG_BIN:-$(pg_config --bindir 2>/dev/null || echo /usr/lib/postgresql/16/bin)}
PORT=${PGPORT_TEST:-54329}
DIR=$(mktemp -d)
as_pg() { if [ "$(id -u)" = 0 ]; then runuser -u postgres -- "$@"; else "$@"; fi; }
[ "$(id -u)" = 0 ] && chown postgres "$DIR"

cleanup() { as_pg "$PG_BIN/pg_ctl" -D "$DIR/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$DIR"; }
trap cleanup EXIT INT TERM

as_pg "$PG_BIN/initdb" -D "$DIR/data" -U postgres --auth=trust >/dev/null
as_pg "$PG_BIN/pg_ctl" -D "$DIR/data" -l "$DIR/log" -w \
  -o "-p $PORT -k $DIR -c listen_addresses='' -c deadlock_timeout=50ms -c max_connections=20" start >/dev/null
q() { psql -h "$DIR" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -qAtX "$@"; }

# The last definition of function $2 in migration file $1.
extract() {
  awk -v n="$2" '
    index($0, "create or replace function " n "(") == 1 || index($0, "create function " n "(") == 1 { f = 1; buf = "" }
    f { buf = buf $0 "\n" }
    f && /^\$\$;/ { f = 0; last = buf }
    END { if (last == "") exit 1; printf "%s", last }' "$1"
}

q <<'SQL'
create schema private;
create schema harness;
create type public.wallet_account   as enum ('capital', 'spot', 'forex', 'options');
create type public.ledger_kind      as enum ('option_premium', 'option_settle', 'option_refund', 'fee');
create type public.option_direction as enum ('rise', 'fall');
create type public.option_status    as enum ('open', 'settled', 'void');
create type public.option_result    as enum ('win', 'loss', 'draw');
create table public.wallets (
  id uuid primary key default gen_random_uuid(), user_id uuid not null, account public.wallet_account not null,
  available_cents bigint not null default 0 check (available_cents >= 0),
  held_cents bigint not null default 0 check (held_cents >= 0),
  updated_at timestamptz not null default now(), unique (user_id, account));
create table public.ledger (
  id bigint generated always as identity primary key, user_id uuid not null,
  wallet_id uuid not null references public.wallets (id), account public.wallet_account not null,
  kind public.ledger_kind not null, delta_cents bigint not null, held_delta_cents bigint not null,
  balance_after_cents bigint not null, held_after_cents bigint not null, pnl_cents bigint not null,
  asset text, asset_delta numeric, ref_type text not null, ref_id uuid not null, actor_id uuid, memo text,
  counter_account public.wallet_account);
create table public.markets (id text primary key, enabled boolean not null, options_enabled boolean not null);
create table public.price_snapshots (
  market_id text primary key references public.markets (id), bid numeric not null, ask numeric not null,
  fetched_at timestamptz not null, source text not null, ingested_at timestamptz not null);
create table public.options_positions (
  id uuid primary key default gen_random_uuid(), n integer, user_id uuid not null,
  market_id text not null references public.markets (id), direction public.option_direction not null,
  premium_cents bigint not null, fee_cents bigint not null, profit_rate_bps integer not null,
  entry_price numeric not null, expires_at timestamptz not null,
  status public.option_status not null default 'open', result public.option_result,
  settle_price numeric, settle_price_at timestamptz, payout_cents bigint, settled_at timestamptz);
create index on public.options_positions (market_id, expires_at) where status = 'open';
insert into public.markets values ('A-USDT', true, true), ('B-USDT', true, true), ('C-USDT', true, true), ('D-USDT', true, true);

-- Fresh users, each with an options wallet of 1,000,000 cents.
create function harness.reset(p_users integer) returns void language sql as $$
  truncate public.ledger, public.options_positions, public.price_snapshots, public.wallets;
  insert into public.wallets (user_id, account, available_cents)
  select gen_random_uuid(), 'options', 1000000 from generate_series(1, p_users);
$$;
-- Every wallet equals its start plus its ledger rows and no position is paid twice.
create function harness.broken() returns bigint language sql as $$
  select (select count(*) from public.wallets w
           where w.available_cents <> 1000000 + coalesce((select sum(delta_cents) from public.ledger l
                                                          where l.wallet_id = w.id), 0))
       + (select count(*) from (select ref_id from public.ledger group by ref_id having count(*) > 1) d);
$$;
create function harness.prices() returns jsonb language sql as $$
  select jsonb_agg(jsonb_build_object('market_id', id, 'bid', '100', 'ask', '102', 'ts', now()::text,
                                      'source', 'vision') order by id)
    from public.markets;
$$;
SQL

{
  extract "$MIG/20261025190257_auth_profiles.sql"            private.lock_wallets
  extract "$MIG/20261025233700_wallets_transfer_admin.sql"   private.wallet_apply
  extract "$MIG/20261026130512_spot_market_orders.sql"       private.parse_decimal
  extract "$MIG/20261026182324_options_settlement.sql"       private.settle_options
  extract "$MIG/20261026183757_options_followups.sql"        private.void_stale_options
} | q

fail=0
same_before=""

run_variant() {
  local label=$1 file=$2
  extract "$file" public.ingest_prices | q

  # race
  local dl_ingest=0 dl_void=0 stranded=0 broken=0 r a b d
  for r in $(seq 1 "$ROUNDS"); do
    q >/dev/null <<'SQL'
select harness.reset(120);
-- One void-eligible position per user (expired 100 s ago).
insert into public.options_positions (user_id, market_id, direction, premium_cents, fee_cents, profit_rate_bps, entry_price, expires_at)
select user_id, 'A-USDT', 'rise', 5000, 5, 600, 100, now() - interval '100 seconds' from public.wallets;
-- One due position per user (expired 5 s ago) on a random market.
insert into public.options_positions (user_id, market_id, direction, premium_cents, fee_cents, profit_rate_bps, entry_price, expires_at)
select user_id, (array['A-USDT','B-USDT','C-USDT','D-USDT'])[1 + floor(random() * 4)::int],
       'rise', 5000, 5, 600, 100, now() - interval '5 seconds' from public.wallets;
SQL
    # Random start order and offset: Postgres aborts the side that waited first.
    d="0.00$((RANDOM % 10))"
    if [ $((RANDOM % 2)) = 0 ]; then
      q -c "select public.ingest_prices(harness.prices())" >"$DIR/ingest.out" 2>&1 & a=$!
      sleep "$d"; q -c "select private.void_stale_options()" >"$DIR/void.out" 2>&1 & b=$!
    else
      q -c "select private.void_stale_options()" >"$DIR/void.out" 2>&1 & b=$!
      sleep "$d"; q -c "select public.ingest_prices(harness.prices())" >"$DIR/ingest.out" 2>&1 & a=$!
    fi
    wait "$a" || true; wait "$b" || true
    dl_ingest=$((dl_ingest + $(grep -c 'deadlock detected' "$DIR/ingest.out" || true)))
    dl_void=$((dl_void + $(grep -c 'deadlock detected' "$DIR/void.out" || true)))
    stranded=$((stranded + $(q -c "select count(*) from public.options_positions where status = 'open' and expires_at > now() - interval '60 seconds'")))
    broken=$((broken + $(q -c "select harness.broken()")))
  done

  # >500
  local left
  left=$(q <<'SQL'
select harness.reset(1200);
insert into public.options_positions (user_id, market_id, direction, premium_cents, fee_cents, profit_rate_bps, entry_price, expires_at)
select user_id, 'A-USDT', 'rise', 5000, 5, 600, 100, now() - interval '5 seconds' from public.wallets;
select public.ingest_prices(harness.prices()) is not null;
select count(*) from public.options_positions where status = 'open';
SQL
)
  left=$(printf '%s\n' "$left" | tail -n 1)

  # same: 300 positions over 4 markets, entry prices around the mid of 101 so
  # there are wins, losses and draws, premiums from 4900 to 5198.
  local same
  same=$(q <<'SQL' | md5sum | cut -c1-12
select harness.reset(300);
with u as (select user_id, row_number() over (order by user_id) as n from public.wallets)
insert into public.options_positions (n, user_id, market_id, direction, premium_cents, fee_cents, profit_rate_bps, entry_price, expires_at)
select n, user_id, (array['A-USDT','B-USDT','C-USDT','D-USDT'])[1 + n % 4],
       case when n % 2 = 0 then 'rise' else 'fall' end::public.option_direction,
       4900 + n, 5, 600, 100 + (n % 3), now() - interval '5 seconds' from u;
select public.ingest_prices(harness.prices()) - 'accepted' - 'rejected' - 'ignored';
select p.n, p.status, p.result, p.payout_cents, p.settle_price, l.kind, l.delta_cents, l.pnl_cents, l.ref_type
  from public.options_positions p
  left join public.ledger l on l.ref_id = p.id
 order by p.n, l.kind;
SQL
)

  printf '%-7s race: %d rounds, deadlocks %d in ingest and %d in void, %d stranded, %d broken | >500: %d left open | fixed set %s\n' \
    "$label" "$ROUNDS" "$dl_ingest" "$dl_void" "$stranded" "$broken" "$left" "$same"

  if [ "$label" = before ]; then
    same_before=$same
  else
    [ $((dl_ingest + dl_void)) -eq 0 ] || { echo "FAIL: deadlocks after the fix"; fail=1; }
    [ "$stranded" -eq 0 ]  || { echo "FAIL: stranded positions after the fix"; fail=1; }
    [ "$left" -eq 0 ]      || { echo "FAIL: positions left open past 500"; fail=1; }
    [ "$same" = "$same_before" ] || { echo "FAIL: fixed set differs from before"; fail=1; }
  fi
  [ "$broken" -eq 0 ] || { echo "FAIL: $label broke a balance or paid twice"; fail=1; }
}

run_variant before "$MIG/20261026183757_options_followups.sql"
run_variant after  "$MIG/20261031110000_options_settle_lock_order.sql"
[ "$fail" -eq 0 ] && echo "PASS"
exit "$fail"
