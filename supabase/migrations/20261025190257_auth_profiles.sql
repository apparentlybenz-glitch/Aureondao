-- =============================================================================
-- Slice 1: auth, profiles, wallets, ledger, signup trigger, access token hook.
-- Cut from the proposal in 20261025000000_initial_schema.sql (O18: one migration
-- per slice, only that slice's tables). Applied through the Management API.
--
-- Conventions (same as the proposal):
--   * Cash is BIGINT minor units (USDT cents). Columns end in _cents.
--   * Every balance change goes through private.wallet_apply, which writes a
--     ledger row in the same transaction. A trigger blocks any other UPDATE of
--     wallet balance rows.
--   * Wallets are locked in ascending id order (private.lock_wallets).
--   * SECURITY DEFINER functions set search_path = '' and use qualified names.
--   * Errors: RAISE EXCEPTION '<CODE>' (SQLSTATE P0001).
-- Signup creates a profile and 4 wallets at 0. Virtual funds are credited by an
-- admin (slice 2), not by the trigger.
-- =============================================================================

-- Non-exposed schema for helpers. PostgREST exposes only "public".
create schema if not exists private;

-- -----------------------------------------------------------------------------
-- 1. Types
-- -----------------------------------------------------------------------------
create type public.wallet_account as enum ('capital', 'spot', 'forex', 'options');
create type public.kyc_status     as enum ('none', 'pending', 'approved', 'rejected');
create type public.app_role       as enum ('admin');
create type public.ledger_kind as enum (
  'transfer_in', 'transfer_out',
  'deposit',
  'withdrawal_hold', 'withdrawal_release', 'withdrawal_paid',
  'admin_credit', 'admin_debit',
  'order_hold', 'order_release',
  'spot_buy', 'spot_sell',
  'forex_margin', 'forex_close',
  'option_premium', 'option_settle',
  'fee'
);

-- -----------------------------------------------------------------------------
-- 2. Tables
-- -----------------------------------------------------------------------------

-- 2.1 profiles (1:1 with auth.users; created by the signup trigger)
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  uid         bigint not null unique check (uid between 10000000 and 99999999), -- public 8-digit UID
  email       text,                                   -- mirrored from auth.users by trigger
  nickname    text not null check (char_length(nickname) between 1 and 32),
  phone       text check (phone is null or phone ~ '^\+?[0-9 ()-]{6,20}$'),
  country     text check (country is null or country ~ '^[A-Z]{2}$'),       -- ISO 3166-1 alpha-2
  kyc_status  public.kyc_status not null default 'none',
  created_at  timestamptz not null default now()
);
create index profiles_email_idx on public.profiles (lower(email));

-- 2.2 user_roles (admin membership; managed by SQL/dashboard only)
create table public.user_roles (
  user_id     uuid not null references auth.users (id) on delete cascade,
  role        public.app_role not null,
  granted_at  timestamptz not null default now(),
  granted_by  uuid references auth.users (id) on delete set null,
  primary key (user_id, role)
);

-- 2.3 wallets: one cash (USDT cents) row per user per sub-wallet
create table public.wallets (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles (id) on delete cascade,
  account          public.wallet_account not null,
  currency         text not null default 'USDT' check (currency = 'USDT'),
  available_cents  bigint not null default 0 check (available_cents >= 0),
  held_cents       bigint not null default 0 check (held_cents >= 0),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (user_id, account)
);

-- 2.4 ledger ("Bills"): one row per change to a wallets row
create table public.ledger (
  id                   bigint generated always as identity primary key,
  user_id              uuid not null references public.profiles (id) on delete cascade,
  wallet_id            uuid not null references public.wallets (id),
  account              public.wallet_account not null,
  kind                 public.ledger_kind not null,
  delta_cents          bigint not null default 0,      -- change to available_cents
  held_delta_cents     bigint not null default 0,      -- change to held_cents
  balance_after_cents  bigint not null check (balance_after_cents >= 0),
  held_after_cents     bigint not null check (held_after_cents >= 0),
  pnl_cents            bigint not null default 0,      -- realized PnL recognized by this row
  asset                text,                           -- spot fills: base asset
  asset_delta          numeric(38,18),                 -- spot fills: +qty buy / -qty sell
  ref_type             text not null check (ref_type in ('transfer', 'order', 'forex_position',
                         'options_position', 'deposit', 'withdrawal', 'admin_adjustment')),
  ref_id               uuid not null,
  actor_id             uuid references auth.users (id) on delete set null,
  memo                 text,
  created_at           timestamptz not null default now(),
  check (delta_cents <> 0 or held_delta_cents <> 0 or pnl_cents <> 0 or asset_delta is not null),
  check ((asset is null) = (asset_delta is null))
);
create index ledger_user_created_idx on public.ledger (user_id, created_at desc, id desc);
create index ledger_wallet_idx on public.ledger (wallet_id, id);
create index ledger_ref_idx on public.ledger (ref_type, ref_id);
create index ledger_user_pnl_idx on public.ledger (user_id, created_at) include (pnl_cents) where pnl_cents <> 0;

-- -----------------------------------------------------------------------------
-- 3. Private helpers
-- -----------------------------------------------------------------------------

-- 3.1 Admin check. SECURITY DEFINER: runs as the table owner, which bypasses RLS
-- on user_roles, so policies that call it cannot recurse. Never FORCE RLS on user_roles.
create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles r
    where r.user_id = (select auth.uid()) and r.role = 'admin'
  );
$$;

-- 3.2 Lock wallets in ascending id order (the only way wallets are locked).
create or replace function private.lock_wallets(p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from public.wallets where id = any (p_ids) order by id for update;
end;
$$;

-- 3.3 Guard: wallet balance rows may only be updated by private.wallet_apply.
create or replace function private.guard_balance_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(current_setting('aureonx.balance_write', true), '') <> 'on' then
    raise exception 'DIRECT_BALANCE_WRITE_FORBIDDEN' using detail = tg_table_name;
  end if;
  return new;
end;
$$;

-- 3.4 THE cash mutation primitive. Caller must already hold the wallet lock.
-- Writes exactly one ledger row per call, in the caller's transaction.
create or replace function private.wallet_apply(
  p_wallet_id    uuid,
  p_delta_cents  bigint,
  p_held_delta   bigint,
  p_kind         public.ledger_kind,
  p_ref_type     text,
  p_ref_id       uuid,
  p_pnl_cents    bigint  default 0,
  p_asset        text    default null,
  p_asset_delta  numeric default null,
  p_actor_id     uuid    default null,
  p_memo         text    default null
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_w  public.wallets;
  v_id bigint;
begin
  select * into v_w from public.wallets where id = p_wallet_id for update;  -- re-entrant
  if not found then
    raise exception 'WALLET_NOT_FOUND';
  end if;
  if v_w.available_cents + p_delta_cents < 0 then
    raise exception 'INSUFFICIENT_FUNDS'
      using detail = format('available=%s required=%s', v_w.available_cents, -p_delta_cents);
  end if;
  if v_w.held_cents + p_held_delta < 0 then
    raise exception 'INVARIANT_HELD_NEGATIVE' using detail = p_wallet_id::text;
  end if;

  if p_delta_cents <> 0 or p_held_delta <> 0 then
    perform set_config('aureonx.balance_write', 'on', true);
    update public.wallets
       set available_cents = available_cents + p_delta_cents,
           held_cents      = held_cents + p_held_delta,
           updated_at      = now()
     where id = p_wallet_id
    returning * into v_w;
    perform set_config('aureonx.balance_write', 'off', true);
  end if;

  insert into public.ledger (user_id, wallet_id, account, kind, delta_cents, held_delta_cents,
                             balance_after_cents, held_after_cents, pnl_cents, asset, asset_delta,
                             ref_type, ref_id, actor_id, memo)
  values (v_w.user_id, v_w.id, v_w.account, p_kind, p_delta_cents, p_held_delta,
          v_w.available_cents, v_w.held_cents, p_pnl_cents, p_asset, p_asset_delta,
          p_ref_type, p_ref_id, p_actor_id, p_memo)
  returning id into v_id;
  return v_id;
end;
$$;

-- 3.5 Signup: profile + 4 wallets at 0. Keep minimal: any error here fails the
-- signup ("Database error saving new user"), which beats a user without wallets.
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   bigint;
  v_tries integer := 0;
begin
  loop
    v_uid := 10000000 + floor(random() * 90000000)::bigint;
    begin
      insert into public.profiles (id, uid, email, nickname)
      values (new.id, v_uid, new.email,
              left(coalesce(nullif(trim(new.raw_user_meta_data ->> 'nickname'), ''),
                            'User' || right(v_uid::text, 4)), 32));
      exit;
    exception when unique_violation then
      v_tries := v_tries + 1;
      if v_tries >= 10 then
        raise;
      end if;
    end;
  end loop;

  insert into public.wallets (user_id, account)
  values (new.id, 'capital'), (new.id, 'spot'), (new.id, 'forex'), (new.id, 'options');
  return new;
end;
$$;

create or replace function private.handle_user_email_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles set email = new.email where id = new.id;
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Triggers
-- -----------------------------------------------------------------------------
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row when (old.email is distinct from new.email)
  execute function private.handle_user_email_change();

create trigger wallets_guard_balance
  before update on public.wallets
  for each row execute function private.guard_balance_write();

-- -----------------------------------------------------------------------------
-- 5. Public RPCs (authenticated)
-- -----------------------------------------------------------------------------

-- 5.1 update_profile. Null or blank nickname keeps the current one; blank
-- phone/country clears them.
create or replace function public.update_profile(p_nickname text, p_phone text, p_country text)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_p   public.profiles;
begin
  if v_uid is null then raise exception 'UNAUTHENTICATED'; end if;
  update public.profiles
     set nickname = coalesce(nullif(trim(p_nickname), ''), nickname),
         phone    = nullif(trim(p_phone), ''),
         country  = nullif(upper(trim(p_country)), '')
   where id = v_uid
  returning * into v_p;
  if not found then raise exception 'PROFILE_NOT_FOUND'; end if;
  return v_p;
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Auth hook: top-level "user_role" claim ('admin' or 'user') for routing only.
-- Authorization in SQL always uses private.is_admin() (live table read).
-- Enabled through the Management API (auth config hook_custom_access_token_*).
-- -----------------------------------------------------------------------------
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_claims jsonb := event -> 'claims';
  v_admin  boolean;
begin
  select exists (select 1 from public.user_roles r
                  where r.user_id = (event ->> 'user_id')::uuid and r.role = 'admin')
    into v_admin;
  v_claims := jsonb_set(v_claims, '{user_role}',
                        to_jsonb(case when v_admin then 'admin' else 'user' end));
  return jsonb_set(event, '{claims}', v_claims);
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. Row Level Security
-- -----------------------------------------------------------------------------
alter table public.profiles   enable row level security;
alter table public.user_roles enable row level security;
alter table public.wallets    enable row level security;
alter table public.ledger     enable row level security;

-- Own-or-admin SELECT. No INSERT/UPDATE/DELETE policies: all writes are RPCs.
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select private.is_admin()));
create policy user_roles_select on public.user_roles for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));
create policy user_roles_auth_hook on public.user_roles for select to supabase_auth_admin
  using (true);
create policy wallets_select on public.wallets for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));
create policy ledger_select on public.ledger for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));

-- -----------------------------------------------------------------------------
-- 8. Grants (defense in depth on top of RLS)
-- -----------------------------------------------------------------------------
-- Supabase default privileges grant ALL on new public tables/functions to
-- anon/authenticated. Remove them; re-grant only SELECT.
revoke all on all tables in schema public from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;

grant select on public.profiles, public.user_roles, public.wallets, public.ledger to authenticated;

-- Functions: nothing is executable by default.
revoke all on all functions in schema public  from public, anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;
alter default privileges for role postgres in schema public  revoke execute on functions from public, anon, authenticated;
alter default privileges for role postgres in schema private revoke execute on functions from public, anon, authenticated;

-- RLS policies call private.is_admin() as the querying role.
grant usage on schema private to authenticated;
grant execute on function private.is_admin() to authenticated;

grant execute on function public.update_profile(text, text, text) to authenticated;

-- Auth hook
grant usage on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
grant select on public.user_roles to supabase_auth_admin;
-- Trigger functions on auth.users
grant usage on schema private to supabase_auth_admin;
grant execute on function private.handle_new_user() to supabase_auth_admin;
grant execute on function private.handle_user_email_change() to supabase_auth_admin;

-- -----------------------------------------------------------------------------
-- 9. Realtime: postgres_changes for the owner's rows (RLS applies per subscriber).
-- ledger is not published on purpose: Bills refetch on a wallet change.
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.wallets, public.profiles;
  end if;
end;
$$;
