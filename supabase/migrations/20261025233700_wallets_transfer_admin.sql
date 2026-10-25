-- =============================================================================
-- Slice 2: transfers between own wallets, admin credit/debit, Bills fields.
-- Cut from the proposal in 20261025000000_initial_schema.sql (O18). Applied
-- through the Management API.
--
-- Owner decisions (slice 2):
--   * Bills text is rendered by the UI from en.json. The ledger row carries
--     structured fields (kind + counter_account), never display copy.
--   * private.is_admin() requires aal2, so every admin power (RLS reads and
--     admin RPCs) needs a second factor.
--   * transfers and admin_audit_log are not readable over the API.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Ledger: the other wallet of a transfer leg, for "Transfer: Spot to Options".
-- -----------------------------------------------------------------------------
alter table public.ledger
  add column counter_account public.wallet_account,
  add constraint ledger_counter_account_chk
    check ((counter_account is not null) = (kind in ('transfer_in', 'transfer_out')));

-- -----------------------------------------------------------------------------
-- 2. Tables
-- -----------------------------------------------------------------------------

-- 2.1 transfers between a user's own sub-wallets
create table public.transfers (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profiles (id) on delete cascade,
  from_wallet_id     uuid not null references public.wallets (id) on delete cascade,
  to_wallet_id       uuid not null references public.wallets (id) on delete cascade,
  from_account       public.wallet_account not null,
  to_account         public.wallet_account not null,
  amount_cents       bigint not null check (amount_cents > 0),
  client_request_id  uuid not null,
  created_at         timestamptz not null default now(),
  unique (user_id, client_request_id),
  check (from_wallet_id <> to_wallet_id)
);
create index transfers_user_created_idx on public.transfers (user_id, created_at desc);

-- 2.2 admin_audit_log: one row per admin RPC call; also the idempotency key
-- for admin_adjust_balance. Kept when the target user is deleted.
create table public.admin_audit_log (
  id                 uuid primary key default gen_random_uuid(),
  admin_id           uuid references auth.users (id) on delete set null,
  action             text not null,
  target_user_id     uuid references auth.users (id) on delete set null,
  target_id          uuid,
  payload            jsonb not null default '{}',
  client_request_id  uuid unique,
  created_at         timestamptz not null default now()
);
create index admin_audit_created_idx on public.admin_audit_log (created_at desc);

-- -----------------------------------------------------------------------------
-- 3. Private helpers
-- -----------------------------------------------------------------------------

-- 3.1 Admin check: live user_roles row AND an aal2 session. RLS policies and
-- admin RPCs both call this, so an aal1 admin token has no admin power.
create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select auth.jwt()) ->> 'aal', '') = 'aal2'
     and exists (
       select 1 from public.user_roles r
       where r.user_id = (select auth.uid()) and r.role = 'admin'
     );
$$;

-- 3.2 wallet_apply gains p_counter_account. Drop first: adding a parameter
-- with CREATE OR REPLACE would leave an ambiguous overload.
drop function private.wallet_apply(uuid, bigint, bigint, public.ledger_kind, text, uuid,
                                   bigint, text, numeric, uuid, text);

create function private.wallet_apply(
  p_wallet_id        uuid,
  p_delta_cents      bigint,
  p_held_delta       bigint,
  p_kind             public.ledger_kind,
  p_ref_type         text,
  p_ref_id           uuid,
  p_pnl_cents        bigint  default 0,
  p_asset            text    default null,
  p_asset_delta      numeric default null,
  p_actor_id         uuid    default null,
  p_memo             text    default null,
  p_counter_account  public.wallet_account default null
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
                             ref_type, ref_id, actor_id, memo, counter_account)
  values (v_w.user_id, v_w.id, v_w.account, p_kind, p_delta_cents, p_held_delta,
          v_w.available_cents, v_w.held_cents, p_pnl_cents, p_asset, p_asset_delta,
          p_ref_type, p_ref_id, p_actor_id, p_memo, p_counter_account)
  returning id into v_id;
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Public RPCs
-- -----------------------------------------------------------------------------

-- 4.1 transfer_between_wallets: both legs in one transaction, two Bills rows.
-- Idempotent on p_client_request_id (a retry returns the first transfer).
create or replace function public.transfer_between_wallets(
  p_from              public.wallet_account,
  p_to                public.wallet_account,
  p_amount_cents      bigint,
  p_client_request_id uuid
)
returns public.transfers
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_from uuid;
  v_to   uuid;
  v_t    public.transfers;
begin
  if v_uid is null then raise exception 'UNAUTHENTICATED'; end if;
  if p_client_request_id is null or p_from is null or p_to is null then
    raise exception 'INVALID_ARGUMENT';
  end if;
  if p_from = p_to then raise exception 'SAME_WALLET'; end if;
  if p_amount_cents is null or p_amount_cents <= 0 then raise exception 'INVALID_AMOUNT'; end if;

  select id into v_from from public.wallets where user_id = v_uid and account = p_from;
  select id into v_to   from public.wallets where user_id = v_uid and account = p_to;
  if v_from is null or v_to is null then raise exception 'WALLET_NOT_FOUND'; end if;

  perform private.lock_wallets(array[v_from, v_to]);

  select * into v_t from public.transfers
   where user_id = v_uid and client_request_id = p_client_request_id;
  if found then
    if v_t.from_wallet_id <> v_from or v_t.to_wallet_id <> v_to or v_t.amount_cents <> p_amount_cents then
      raise exception 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_t;
  end if;

  insert into public.transfers (user_id, from_wallet_id, to_wallet_id, from_account, to_account,
                                amount_cents, client_request_id)
  values (v_uid, v_from, v_to, p_from, p_to, p_amount_cents, p_client_request_id)
  returning * into v_t;

  perform private.wallet_apply(v_from, -p_amount_cents, 0, 'transfer_out', 'transfer', v_t.id,
                               p_counter_account => p_to);
  perform private.wallet_apply(v_to, p_amount_cents, 0, 'transfer_in', 'transfer', v_t.id,
                               p_counter_account => p_from);
  return v_t;
end;
$$;

-- 4.2 admin_adjust_balance: credit (> 0) or debit (< 0) a user's virtual balance.
-- Checks the user_role claim, aal2 and the live user_roles row. Writes one audit
-- row (also the idempotency record) and one Bills row through wallet_apply.
-- The reason stays in the audit log; it is not copied to the user's Bills row.
create or replace function public.admin_adjust_balance(
  p_user_id           uuid,
  p_account           public.wallet_account,
  p_delta_cents       bigint,
  p_reason            text,
  p_client_request_id uuid
)
returns public.admin_audit_log
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin  uuid := auth.uid();
  v_wallet uuid;
  v_a      public.admin_audit_log;
begin
  if v_admin is null then raise exception 'UNAUTHENTICATED'; end if;
  if coalesce(auth.jwt() ->> 'user_role', '') <> 'admin' then raise exception 'FORBIDDEN'; end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then raise exception 'AAL2_REQUIRED'; end if;
  if not private.is_admin() then raise exception 'FORBIDDEN'; end if;

  if p_user_id is null or p_client_request_id is null or p_account is null then
    raise exception 'INVALID_ARGUMENT';
  end if;
  if p_delta_cents is null or p_delta_cents = 0 or abs(p_delta_cents) > 100000000000 then
    raise exception 'INVALID_AMOUNT';
  end if;
  if coalesce(char_length(trim(p_reason)), 0) < 3 or char_length(p_reason) > 200 then
    raise exception 'NOTE_REQUIRED';
  end if;

  select id into v_wallet from public.wallets where user_id = p_user_id and account = p_account;
  if v_wallet is null then raise exception 'WALLET_NOT_FOUND'; end if;
  perform private.lock_wallets(array[v_wallet]);

  select * into v_a from public.admin_audit_log where client_request_id = p_client_request_id;
  if found then
    if v_a.target_id is distinct from v_wallet
       or (v_a.payload ->> 'delta_cents')::bigint <> p_delta_cents then
      raise exception 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_a;
  end if;

  insert into public.admin_audit_log (admin_id, action, target_user_id, target_id, payload, client_request_id)
  values (v_admin, 'adjust_balance', p_user_id, v_wallet,
          jsonb_build_object('account', p_account, 'delta_cents', p_delta_cents,
                             'reason', trim(p_reason)),
          p_client_request_id)
  returning * into v_a;

  -- A debit takes available funds only (never held); INSUFFICIENT_FUNDS otherwise.
  perform private.wallet_apply(v_wallet, p_delta_cents, 0,
                               case when p_delta_cents > 0 then 'admin_credit'::public.ledger_kind
                                    else 'admin_debit'::public.ledger_kind end,
                               'admin_adjustment', v_a.id, p_actor_id => v_admin);
  return v_a;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. RLS and grants
-- -----------------------------------------------------------------------------
-- No policies: neither table is readable or writable over the API. The RPCs
-- (SECURITY DEFINER) are the only writers. Bills is the user-facing record.
alter table public.transfers       enable row level security;
alter table public.admin_audit_log enable row level security;
revoke all on public.transfers, public.admin_audit_log from anon, authenticated;

revoke all on function private.wallet_apply(uuid, bigint, bigint, public.ledger_kind, text, uuid,
                                            bigint, text, numeric, uuid, text, public.wallet_account)
  from public, anon, authenticated;
revoke all on function public.transfer_between_wallets(public.wallet_account, public.wallet_account, bigint, uuid)
  from public, anon;
revoke all on function public.admin_adjust_balance(uuid, public.wallet_account, bigint, text, uuid)
  from public, anon;
grant execute on function public.transfer_between_wallets(public.wallet_account, public.wallet_account, bigint, uuid)
  to authenticated;
grant execute on function public.admin_adjust_balance(uuid, public.wallet_account, bigint, text, uuid)
  to authenticated;
