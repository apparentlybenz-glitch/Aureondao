-- =============================================================================
-- Admin tiers: Top-Up, Option periods, Forex periods, Delete account and the
-- audit log are head admin only. Applied through the Management API.
--
-- Rollback (run as postgres in one transaction):
--   do $r$
--   declare f regprocedure;
--   begin
--     foreach f in array array[
--       'public.admin_adjust_balance(uuid, public.wallet_account, bigint, uuid)'::regprocedure,
--       'public.admin_set_option_period(integer, integer, integer, bigint, boolean)'::regprocedure,
--       'public.admin_set_fx_period(integer, integer, integer, bigint, boolean)'::regprocedure,
--       'public.admin_delete_user(uuid, uuid)'::regprocedure]
--     loop
--       execute replace(pg_get_functiondef(f),
--         E'  if not private.is_head_admin() then raise exception ''FORBIDDEN''; end if;\n', '');
--     end loop;
--   end $r$;
--   alter policy admin_audit_log_select on public.admin_audit_log using ((select private.is_admin()));
--   revoke execute on function private.is_head_admin() from authenticated;
--
-- * Two tiers: an admin is a live user_roles admin row; a head admin is that row
--   with is_head (the owner is always a head admin). Ordinary admins keep User
--   Search, Restrictions, Outcome control, KYC Review and Support tickets.
-- * admin_adjust_balance, admin_set_option_period, admin_set_fx_period and
--   admin_delete_user keep the user_role claim and private.is_admin() checks and
--   add private.is_head_admin(), refused with FORBIDDEN like admin_set_admin.
--   Each body is otherwise the live definition, unchanged. create or replace
--   keeps the existing grants.
-- * admin_audit_log_select reads private.is_head_admin(). A policy calls it as the
--   querying role, so authenticated gets EXECUTE on it, the same grant
--   private.is_admin() has (authenticated already has USAGE on schema private,
--   from 20261025190257_auth_profiles.sql). private is not an exposed API schema,
--   so the grant adds no endpoint. private.is_owner() stays not executable.
-- * ledger, profiles, wallets, kyc_submissions and user_roles policies are
--   unchanged: User Search still reads every user's wallets and Bills rows.
-- =============================================================================

grant execute on function private.is_head_admin() to authenticated;

alter policy admin_audit_log_select on public.admin_audit_log using ((select private.is_head_admin()));

create or replace function public.admin_adjust_balance(p_user_id uuid, p_account public.wallet_account, p_delta_cents bigint, p_client_request_id uuid)
 returns public.admin_audit_log
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_admin  uuid := auth.uid();
  v_wallet uuid;
  v_a      public.admin_audit_log;
begin
  if v_admin is null then raise exception 'UNAUTHENTICATED'; end if;
  if coalesce(auth.jwt() ->> 'user_role', '') <> 'admin' then raise exception 'FORBIDDEN'; end if;
  if not private.is_admin() then raise exception 'FORBIDDEN'; end if;
  if not private.is_head_admin() then raise exception 'FORBIDDEN'; end if;

  if p_user_id is null or p_client_request_id is null or p_account is null then
    raise exception 'INVALID_ARGUMENT';
  end if;
  if p_delta_cents is null or p_delta_cents = 0 or abs(p_delta_cents) > 100000000000 then
    raise exception 'INVALID_AMOUNT';
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
          jsonb_build_object('account', p_account, 'delta_cents', p_delta_cents),
          p_client_request_id)
  returning * into v_a;

  -- A debit takes available funds only (never held); INSUFFICIENT_FUNDS otherwise.
  -- The user's Bills row says "Balance adjustment".
  perform private.wallet_apply(v_wallet, p_delta_cents, 0,
                               case when p_delta_cents > 0 then 'admin_credit'::public.ledger_kind
                                    else 'admin_debit'::public.ledger_kind end,
                               'admin_adjustment', v_a.id, p_actor_id => v_admin,
                               p_memo => 'Balance adjustment');
  return v_a;
end;
$function$;

create or replace function public.admin_set_option_period(p_duration_s integer, p_profit_rate_bps integer, p_fee_bps integer, p_min_premium_cents bigint, p_enabled boolean)
 returns public.option_periods
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_admin uuid := auth.uid();
  v_p     public.option_periods;
begin
  if v_admin is null then raise exception 'UNAUTHENTICATED'; end if;
  if coalesce(auth.jwt() ->> 'user_role', '') <> 'admin' then raise exception 'FORBIDDEN'; end if;
  if not private.is_admin() then raise exception 'FORBIDDEN'; end if;
  if not private.is_head_admin() then raise exception 'FORBIDDEN'; end if;

  if p_duration_s is null or p_enabled is null
     or p_profit_rate_bps is null or p_profit_rate_bps not between 0 and 100000
     or p_fee_bps is null or p_fee_bps not between 0 and 1000
     or p_min_premium_cents is null or p_min_premium_cents <= 0
     or (p_enabled and p_profit_rate_bps = 0) then
    raise exception 'INVALID_ARGUMENT';
  end if;

  update public.option_periods
     set profit_rate_bps = p_profit_rate_bps, fee_bps = p_fee_bps, min_premium_cents = p_min_premium_cents,
         enabled = p_enabled, updated_at = now(), updated_by = v_admin
   where duration_s = p_duration_s
  returning * into v_p;
  if not found then raise exception 'PERIOD_NOT_FOUND'; end if;

  insert into public.admin_audit_log (admin_id, action, payload)
  values (v_admin, 'set_option_period', to_jsonb(v_p));
  return v_p;
end;
$function$;

create or replace function public.admin_set_fx_period(p_duration_s integer, p_profit_rate_bps integer, p_fee_bps integer, p_min_premium_cents bigint, p_enabled boolean)
 returns public.fx_periods
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_admin uuid := auth.uid();
  v_p     public.fx_periods;
begin
  if v_admin is null then raise exception 'UNAUTHENTICATED'; end if;
  if coalesce(auth.jwt() ->> 'user_role', '') <> 'admin' then raise exception 'FORBIDDEN'; end if;
  if not private.is_admin() then raise exception 'FORBIDDEN'; end if;
  if not private.is_head_admin() then raise exception 'FORBIDDEN'; end if;

  if p_duration_s is null or p_enabled is null
     or p_profit_rate_bps is null or p_profit_rate_bps not between 0 and 100000
     or p_fee_bps is null or p_fee_bps not between 0 and 1000
     or p_min_premium_cents is null or p_min_premium_cents <= 0
     or (p_enabled and p_profit_rate_bps = 0) then
    raise exception 'INVALID_ARGUMENT';
  end if;

  update public.fx_periods
     set profit_rate_bps = p_profit_rate_bps, fee_bps = p_fee_bps, min_premium_cents = p_min_premium_cents,
         enabled = p_enabled, updated_at = now(), updated_by = v_admin
   where duration_s = p_duration_s
  returning * into v_p;
  if not found then raise exception 'PERIOD_NOT_FOUND'; end if;

  insert into public.admin_audit_log (admin_id, action, payload)
  values (v_admin, 'set_fx_period', to_jsonb(v_p));
  return v_p;
end;
$function$;

create or replace function public.admin_delete_user(p_user_id uuid, p_client_request_id uuid)
 returns public.admin_audit_log
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_admin   uuid := auth.uid();
  v_profile public.profiles;
  v_a       public.admin_audit_log;
begin
  if v_admin is null then raise exception 'UNAUTHENTICATED'; end if;
  if coalesce(auth.jwt() ->> 'user_role', '') <> 'admin' then raise exception 'FORBIDDEN'; end if;
  if not private.is_admin() then raise exception 'FORBIDDEN'; end if;
  if not private.is_head_admin() then raise exception 'FORBIDDEN'; end if;

  if p_user_id is null or p_client_request_id is null then
    raise exception 'INVALID_ARGUMENT';
  end if;

  -- The profile lock serializes calls on one user, so a concurrent call with the
  -- same key waits, then finds the audit row below (the profile is gone by then).
  select * into v_profile from public.profiles where id = p_user_id for update;

  select * into v_a from public.admin_audit_log where client_request_id = p_client_request_id;
  if found then
    if v_a.action <> 'delete_user' or (v_a.payload ->> 'user_id') is distinct from p_user_id::text then
      raise exception 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_a;
  end if;

  if v_profile.id is null then raise exception 'INVALID_ARGUMENT'; end if;
  if p_user_id = v_admin then raise exception 'CANNOT_DELETE_SELF'; end if;
  if exists (select 1 from public.user_roles where user_id = p_user_id and role = 'admin') then
    raise exception 'ADMIN_PROTECTED';
  end if;

  insert into public.admin_audit_log (admin_id, action, target_user_id, payload, client_request_id)
  values (v_admin, 'delete_user', p_user_id,
          jsonb_build_object('user_id', p_user_id, 'uid', v_profile.uid::text, 'email', v_profile.email),
          p_client_request_id)
  returning * into v_a;

  delete from auth.users where id = p_user_id;
  -- The audit row's target_user_id was set null by that delete; return it as stored.
  select * into v_a from public.admin_audit_log where id = v_a.id;
  return v_a;
end;
$function$;
