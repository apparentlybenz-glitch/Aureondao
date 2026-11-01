-- =============================================================================
-- Admin outcome control (Options only).
--
-- * public.outcome_config: one row. The platform default mode for Options
--   settlement. mode is market, force_win, force_loss or controlled.
--   controlled rolls win_rate_pct per position with pg_catalog.random().
-- * public.outcome_overrides: one row per user, the same columns. A row wins
--   over the global config.
-- * options_positions.outcome_source records which mode settled the position.
-- * private.settle_options is replaced to apply the effective mode before the
--   payout math. The real settle price is still stored; only result and payout
--   are forced. Spot and Forex are untouched.
-- * Admin reads: RLS with private.is_admin(). Writes: the three RPCs below,
--   each with the admin_set_suspension checks (claim and live admin row) and
--   one admin_audit_log row.
--
-- Not applied automatically. The owner runs this file in the Supabase SQL
-- editor (or through the Management API) and then records its history row.
-- =============================================================================

-- 1. Config and overrides.
create table public.outcome_config (
  id             smallint primary key default 1 check (id = 1),
  mode           text not null default 'market'
                   check (mode in ('market', 'force_win', 'force_loss', 'controlled')),
  win_rate_pct   smallint not null default 50 check (win_rate_pct between 0 and 100),
  updated_by     uuid references auth.users (id) on delete set null,
  updated_at     timestamptz not null default now()
);

insert into public.outcome_config (id) values (1);

create table public.outcome_overrides (
  user_id        uuid primary key references public.profiles (id) on delete cascade,
  mode           text not null
                   check (mode in ('market', 'force_win', 'force_loss', 'controlled')),
  win_rate_pct   smallint not null default 50 check (win_rate_pct between 0 and 100),
  updated_by     uuid references auth.users (id) on delete set null,
  updated_at     timestamptz not null default now()
);

alter table public.options_positions
  add column outcome_source text
    check (outcome_source is null or outcome_source in ('market', 'force_win', 'force_loss', 'controlled'));

alter table public.outcome_config enable row level security;
alter table public.outcome_overrides enable row level security;

create policy outcome_config_select on public.outcome_config
  for select to authenticated using ((select private.is_admin()));
create policy outcome_overrides_select on public.outcome_overrides
  for select to authenticated using ((select private.is_admin()));

revoke all on public.outcome_config from anon, authenticated;
revoke all on public.outcome_overrides from anon, authenticated;
grant select on public.outcome_config to authenticated;
grant select on public.outcome_overrides to authenticated;

-- 2. Resolve an email to the one profile that uses it.
create or replace function private.outcome_user_by_email(p_email text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_email is null or char_length(trim(p_email)) = 0 then
    raise exception 'INVALID_ARGUMENT';
  end if;
  select id into v_id
    from public.profiles
   where lower(email) = lower(trim(p_email))
   limit 1;
  if not found then raise exception 'USER_NOT_FOUND'; end if;
  return v_id;
end;
$$;

revoke all on function private.outcome_user_by_email(text) from public, anon, authenticated;

-- 3. Admin RPCs.
create or replace function public.admin_set_outcome_config(
  p_mode           text,
  p_win_rate_pct   integer,
  p_client_request_id uuid
)
returns public.admin_audit_log
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin uuid := auth.uid();
  v_a     public.admin_audit_log;
begin
  if v_admin is null then raise exception 'UNAUTHENTICATED'; end if;
  if coalesce(auth.jwt() ->> 'user_role', '') <> 'admin' then raise exception 'FORBIDDEN'; end if;
  if not private.is_admin() then raise exception 'FORBIDDEN'; end if;

  if p_mode is null or p_win_rate_pct is null or p_client_request_id is null then
    raise exception 'INVALID_ARGUMENT';
  end if;
  if p_mode not in ('market', 'force_win', 'force_loss', 'controlled') then
    raise exception 'INVALID_ARGUMENT';
  end if;
  if p_win_rate_pct < 0 or p_win_rate_pct > 100 then
    raise exception 'INVALID_ARGUMENT';
  end if;

  perform 1 from public.outcome_config where id = 1 for update;
  if not found then raise exception 'INVALID_ARGUMENT'; end if;

  select * into v_a from public.admin_audit_log where client_request_id = p_client_request_id;
  if found then
    if v_a.action <> 'outcome_config'
       or (v_a.payload ->> 'mode') is distinct from p_mode
       or (v_a.payload ->> 'win_rate_pct')::integer is distinct from p_win_rate_pct then
      raise exception 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_a;
  end if;

  update public.outcome_config
     set mode = p_mode, win_rate_pct = p_win_rate_pct, updated_by = v_admin, updated_at = now()
   where id = 1;

  insert into public.admin_audit_log (admin_id, action, payload, client_request_id)
  values (v_admin, 'outcome_config',
          jsonb_build_object('mode', p_mode, 'win_rate_pct', p_win_rate_pct),
          p_client_request_id)
  returning * into v_a;
  return v_a;
end;
$$;

create or replace function public.admin_set_outcome_override(
  p_email          text,
  p_mode           text,
  p_win_rate_pct   integer,
  p_client_request_id uuid
)
returns public.admin_audit_log
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin uuid := auth.uid();
  v_user  uuid;
  v_a     public.admin_audit_log;
begin
  if v_admin is null then raise exception 'UNAUTHENTICATED'; end if;
  if coalesce(auth.jwt() ->> 'user_role', '') <> 'admin' then raise exception 'FORBIDDEN'; end if;
  if not private.is_admin() then raise exception 'FORBIDDEN'; end if;

  if p_email is null or p_mode is null or p_win_rate_pct is null or p_client_request_id is null then
    raise exception 'INVALID_ARGUMENT';
  end if;
  if p_mode not in ('market', 'force_win', 'force_loss', 'controlled') then
    raise exception 'INVALID_ARGUMENT';
  end if;
  if p_win_rate_pct < 0 or p_win_rate_pct > 100 then
    raise exception 'INVALID_ARGUMENT';
  end if;

  v_user := private.outcome_user_by_email(p_email);

  -- The profile lock serializes calls on one user, so a concurrent call with the
  -- same key sees the audit row below once the first commits.
  perform 1 from public.profiles where id = v_user for update;

  select * into v_a from public.admin_audit_log where client_request_id = p_client_request_id;
  if found then
    if v_a.action <> 'outcome_override_set'
       or v_a.target_user_id is distinct from v_user
       or (v_a.payload ->> 'mode') is distinct from p_mode
       or (v_a.payload ->> 'win_rate_pct')::integer is distinct from p_win_rate_pct then
      raise exception 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_a;
  end if;

  insert into public.outcome_overrides (user_id, mode, win_rate_pct, updated_by, updated_at)
  values (v_user, p_mode, p_win_rate_pct, v_admin, now())
  on conflict (user_id) do update
    set mode = excluded.mode,
        win_rate_pct = excluded.win_rate_pct,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at;

  insert into public.admin_audit_log (admin_id, action, target_user_id, payload, client_request_id)
  values (v_admin, 'outcome_override_set', v_user,
          jsonb_build_object('email', lower(trim(p_email)), 'mode', p_mode, 'win_rate_pct', p_win_rate_pct),
          p_client_request_id)
  returning * into v_a;
  return v_a;
end;
$$;

create or replace function public.admin_clear_outcome_override(
  p_user_id        uuid,
  p_client_request_id uuid
)
returns public.admin_audit_log
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin uuid := auth.uid();
  v_email text;
  v_a     public.admin_audit_log;
begin
  if v_admin is null then raise exception 'UNAUTHENTICATED'; end if;
  if coalesce(auth.jwt() ->> 'user_role', '') <> 'admin' then raise exception 'FORBIDDEN'; end if;
  if not private.is_admin() then raise exception 'FORBIDDEN'; end if;

  if p_user_id is null or p_client_request_id is null then raise exception 'INVALID_ARGUMENT'; end if;

  select email into v_email from public.profiles where id = p_user_id for update;
  if not found then raise exception 'INVALID_ARGUMENT'; end if;

  select * into v_a from public.admin_audit_log where client_request_id = p_client_request_id;
  if found then
    if v_a.action <> 'outcome_override_clear'
       or v_a.target_user_id is distinct from p_user_id then
      raise exception 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_a;
  end if;

  delete from public.outcome_overrides where user_id = p_user_id;

  insert into public.admin_audit_log (admin_id, action, target_user_id, payload, client_request_id)
  values (v_admin, 'outcome_override_clear', p_user_id,
          jsonb_build_object('email', v_email), p_client_request_id)
  returning * into v_a;
  return v_a;
end;
$$;

revoke all on function public.admin_set_outcome_config(text, integer, uuid) from public, anon;
revoke all on function public.admin_set_outcome_override(text, text, integer, uuid) from public, anon;
revoke all on function public.admin_clear_outcome_override(uuid, uuid) from public, anon;
grant execute on function public.admin_set_outcome_config(text, integer, uuid) to authenticated;
grant execute on function public.admin_set_outcome_override(text, text, integer, uuid) to authenticated;
grant execute on function public.admin_clear_outcome_override(uuid, uuid) to authenticated;

-- 4. Settlement. Same window, locks and payouts as 20261026182324, plus the
-- effective mode: a per-user override wins over the global config. force modes
-- and controlled never draw. The real settle price is still required and stored.
create or replace function private.settle_options(p_market_id text, p_price numeric, p_fetched_at timestamptz)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids     uuid[];
  r         public.options_positions;
  v_result  public.option_result;
  v_mode    text;
  v_rate    integer;
  v_profit  bigint;
  v_payout  bigint;
  v_wallet  uuid;
  v_n       integer := 0;
begin
  with c as (
    select p.id
      from public.options_positions p
     where p.market_id = p_market_id
       and p.status = 'open'
       and p.expires_at <= p_fetched_at
       and p.expires_at >= p_fetched_at - interval '60 seconds'
     order by p.expires_at, p.id
     limit 500
       for update of p skip locked
  )
  select array_agg(id order by id) into v_ids from c;
  if v_ids is null then return 0; end if;

  perform private.lock_wallets(array(
    select w.id from public.wallets w
      join public.options_positions p on p.user_id = w.user_id
     where p.id = any (v_ids) and w.account = 'options'));

  for r in select * from public.options_positions where id = any (v_ids) order by id loop
    select coalesce(o.mode, c.mode, 'market'), coalesce(o.win_rate_pct, c.win_rate_pct, 50)
      into v_mode, v_rate
      from public.outcome_config c
      left join public.outcome_overrides o on o.user_id = r.user_id
     where c.id = 1;
    v_mode := coalesce(v_mode, 'market');
    v_rate := coalesce(v_rate, 50);

    v_profit := 0;
    if v_mode = 'force_win' then
      v_result := 'win';
      v_profit := floor(r.premium_cents::numeric * r.profit_rate_bps / 10000);
      v_payout := r.premium_cents + v_profit;
    elsif v_mode = 'force_loss' then
      v_result := 'loss';
      v_payout := 0;
    elsif v_mode = 'controlled' then
      if pg_catalog.random() * 100 < v_rate then
        v_result := 'win';
        v_profit := floor(r.premium_cents::numeric * r.profit_rate_bps / 10000);
        v_payout := r.premium_cents + v_profit;
      else
        v_result := 'loss';
        v_payout := 0;
      end if;
    else
      v_mode := 'market';
      if p_price = r.entry_price then
        v_result := 'draw';
        v_payout := r.premium_cents;
      elsif (r.direction = 'rise') = (p_price > r.entry_price) then
        v_result := 'win';
        v_profit := floor(r.premium_cents::numeric * r.profit_rate_bps / 10000);
        v_payout := r.premium_cents + v_profit;
      else
        v_result := 'loss';
        v_payout := 0;
      end if;
    end if;

    update public.options_positions
       set status = 'settled', result = v_result, settle_price = p_price, settle_price_at = p_fetched_at,
           payout_cents = v_payout, settled_at = now(), outcome_source = v_mode
     where id = r.id and status = 'open';
    if not found then continue; end if;

    select id into v_wallet from public.wallets where user_id = r.user_id and account = 'options';
    if v_result = 'win' then
      perform private.wallet_apply(v_wallet, v_payout, 0, 'option_settle', 'options_position', r.id,
                                   p_pnl_cents => v_profit);
    elsif v_result = 'loss' then
      perform private.wallet_apply(v_wallet, 0, 0, 'option_settle', 'options_position', r.id,
                                   p_pnl_cents => -r.premium_cents);
    else
      perform private.wallet_apply(v_wallet, v_payout, 0, 'option_refund', 'options_position', r.id);
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

revoke all on function private.settle_options(text, numeric, timestamptz) from public, anon, authenticated;
