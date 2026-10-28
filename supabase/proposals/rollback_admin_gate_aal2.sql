-- Rollback for 20261028120000_admin_gate_aal1.sql: restores the aal2 requirement for admin power.
-- These are the definitions that were live before that migration (identical to the latest repo
-- definitions as of 20261028090000_kyc_photo_view_audit.sql). Not in supabase/migrations/, so a
-- replay never applies it. To restore: apply this file, then revert the client commit.

CREATE OR REPLACE FUNCTION private.is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce((select auth.jwt()) ->> 'aal', '') = 'aal2'
     and exists (
       select 1 from public.user_roles r
       where r.user_id = (select auth.uid()) and r.role = 'admin'
     );
$function$;

CREATE OR REPLACE FUNCTION public.admin_adjust_balance(p_user_id uuid, p_account public.wallet_account, p_delta_cents bigint, p_reason text, p_client_request_id uuid)
 RETURNS public.admin_audit_log
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  -- The user's Bills row says "Balance adjustment"; the reason is not copied.
  perform private.wallet_apply(v_wallet, p_delta_cents, 0,
                               case when p_delta_cents > 0 then 'admin_credit'::public.ledger_kind
                                    else 'admin_debit'::public.ledger_kind end,
                               'admin_adjustment', v_a.id, p_actor_id => v_admin,
                               p_memo => 'Balance adjustment');
  return v_a;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_set_suspension(p_user_id uuid, p_suspended boolean, p_reason text, p_client_request_id uuid)
 RETURNS public.admin_audit_log
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_admin  uuid := auth.uid();
  v_reason text := nullif(trim(p_reason), '');
  v_action text := case when p_suspended then 'suspend' else 'unsuspend' end;
  v_a      public.admin_audit_log;
begin
  if v_admin is null then raise exception 'UNAUTHENTICATED'; end if;
  if coalesce(auth.jwt() ->> 'user_role', '') <> 'admin' then raise exception 'FORBIDDEN'; end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then raise exception 'AAL2_REQUIRED'; end if;
  if not private.is_admin() then raise exception 'FORBIDDEN'; end if;

  if p_user_id is null or p_suspended is null or p_client_request_id is null then
    raise exception 'INVALID_ARGUMENT';
  end if;
  if p_suspended and coalesce(char_length(v_reason), 0) < 3 then raise exception 'NOTE_REQUIRED'; end if;
  if char_length(v_reason) > 200 then raise exception 'NOTE_REQUIRED'; end if;

  -- The profile lock serializes calls on one user, so a concurrent call with the
  -- same key sees the audit row below once it commits.
  perform 1 from public.profiles where id = p_user_id for update;
  if not found then raise exception 'INVALID_ARGUMENT'; end if;

  select * into v_a from public.admin_audit_log where client_request_id = p_client_request_id;
  if found then
    if v_a.action <> v_action or v_a.target_user_id is distinct from p_user_id
       or (v_a.payload ->> 'reason') is distinct from v_reason then
      raise exception 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_a;
  end if;

  if p_suspended then
    update public.profiles
       set suspended_at = coalesce(suspended_at, now()), suspension_reason = v_reason
     where id = p_user_id;
  else
    update public.profiles set suspended_at = null, suspension_reason = null where id = p_user_id;
  end if;

  insert into public.admin_audit_log (admin_id, action, target_user_id, payload, client_request_id)
  values (v_admin, v_action, p_user_id, jsonb_build_object('reason', v_reason), p_client_request_id)
  returning * into v_a;
  return v_a;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_set_option_period(p_duration_s integer, p_profit_rate_bps integer, p_fee_bps integer, p_min_premium_cents bigint, p_enabled boolean)
 RETURNS public.option_periods
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_admin uuid := auth.uid();
  v_p     public.option_periods;
begin
  if v_admin is null then raise exception 'UNAUTHENTICATED'; end if;
  if coalesce(auth.jwt() ->> 'user_role', '') <> 'admin' then raise exception 'FORBIDDEN'; end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then raise exception 'AAL2_REQUIRED'; end if;
  if not private.is_admin() then raise exception 'FORBIDDEN'; end if;

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

CREATE OR REPLACE FUNCTION public.admin_review_kyc(p_submission_id uuid, p_approve boolean, p_reason text, p_client_request_id uuid)
 RETURNS kyc_submissions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_admin  uuid := auth.uid();
  v_reason text := nullif(trim(p_reason), '');
  v_action text := case when p_approve then 'kyc_approve' else 'kyc_reject' end;
  v_a      public.admin_audit_log;
  v_s      public.kyc_submissions;
begin
  if v_admin is null then raise exception 'UNAUTHENTICATED'; end if;
  if coalesce(auth.jwt() ->> 'user_role', '') <> 'admin' then raise exception 'FORBIDDEN'; end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then raise exception 'AAL2_REQUIRED'; end if;
  if not private.is_admin() then raise exception 'FORBIDDEN'; end if;

  if p_submission_id is null or p_approve is null or p_client_request_id is null then
    raise exception 'INVALID_ARGUMENT';
  end if;
  if p_approve then
    v_reason := null;
  elsif coalesce(char_length(v_reason), 0) not between 3 and 200 then
    raise exception 'NOTE_REQUIRED';
  end if;

  -- The row lock serializes reviews of one submission, so a concurrent call
  -- with the same key sees its audit row below once it commits.
  select * into v_s from public.kyc_submissions where id = p_submission_id for update;
  if not found then raise exception 'KYC_NOT_FOUND'; end if;

  select * into v_a from public.admin_audit_log where client_request_id = p_client_request_id;
  if found then
    if v_a.action <> v_action or v_a.target_id is distinct from p_submission_id
       or (v_a.payload ->> 'reason') is distinct from v_reason then
      raise exception 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_s;
  end if;

  update public.kyc_submissions
     set status = case when p_approve then 'approved' else 'rejected' end::public.kyc_status,
         rejection_reason = v_reason, decided_at = now(), decided_by = v_admin
   where id = p_submission_id and status = 'pending'
  returning * into v_s;
  if not found then raise exception 'KYC_NOT_PENDING'; end if;

  insert into public.admin_audit_log (admin_id, action, target_user_id, target_id, payload, client_request_id)
  values (v_admin, v_action, v_s.user_id, v_s.id, jsonb_build_object('reason', v_reason), p_client_request_id);
  return v_s;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_log_kyc_photo_view(p_submission_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_admin uuid := auth.uid();
  v_user  uuid;
begin
  if v_admin is null then raise exception 'UNAUTHENTICATED'; end if;
  if coalesce(auth.jwt() ->> 'user_role', '') <> 'admin' then raise exception 'FORBIDDEN'; end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then raise exception 'AAL2_REQUIRED'; end if;
  if not private.is_admin() then raise exception 'FORBIDDEN'; end if;
  if p_submission_id is null then raise exception 'INVALID_ARGUMENT'; end if;

  select user_id into v_user from public.kyc_submissions where id = p_submission_id;
  if not found then raise exception 'KYC_NOT_FOUND'; end if;

  -- One photo per submission (slice 8).
  insert into public.admin_audit_log (admin_id, action, target_user_id, target_id, payload)
  values (v_admin, 'kyc_photo_view', v_user, p_submission_id, jsonb_build_object('photos', 1));
end;
$function$;
