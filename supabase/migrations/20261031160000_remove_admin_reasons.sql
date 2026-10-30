-- =============================================================================
-- Admins give no reason for any move.
--
-- * admin_adjust_balance, admin_set_suspension, admin_review_kyc, admin_set_admin and
--   admin_demote_head lose p_reason: each old signature is dropped and the new one is
--   created without it. Every other check, error code, lock, return type and audit write
--   stays. NOTE_REQUIRED is no longer raised, a replay no longer compares a reason, and a
--   new audit row carries no reason key (an empty payload is '{}').
-- * profiles loses profiles_suspension_chk and suspension_reason; kyc_submissions loses
--   kyc_reason_chk and rejection_reason. kyc_current (select *) depends on that column,
--   so it is dropped and recreated with security_invoker and the same grants.
-- * Existing admin_audit_log rows are left as they are, reason keys included.
-- =============================================================================

drop function public.admin_adjust_balance(uuid, public.wallet_account, bigint, text, uuid);
drop function public.admin_set_suspension(uuid, boolean, text, uuid);
drop function public.admin_review_kyc(uuid, boolean, text, uuid);
drop function public.admin_set_admin(uuid, boolean, text, uuid);
drop function public.admin_demote_head(uuid, boolean, text, uuid);

alter table public.profiles drop constraint profiles_suspension_chk;
alter table public.profiles drop column suspension_reason;

drop view public.kyc_current;
alter table public.kyc_submissions drop constraint kyc_reason_chk;
alter table public.kyc_submissions drop column rejection_reason;

-- Each user's latest submission. No row means not started.
-- security_invoker keeps the kyc_submissions policy in force.
create view public.kyc_current with (security_invoker = true) as
select distinct on (user_id) *
  from public.kyc_submissions
 order by user_id, submitted_at desc, id desc;
revoke all on public.kyc_current from anon, authenticated;
grant select on public.kyc_current to authenticated;

create function public.admin_adjust_balance(p_user_id uuid, p_account public.wallet_account, p_delta_cents bigint, p_client_request_id uuid)
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

create function public.admin_set_suspension(p_user_id uuid, p_suspended boolean, p_client_request_id uuid)
 returns public.admin_audit_log
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_admin  uuid := auth.uid();
  v_action text := case when p_suspended then 'suspend' else 'unsuspend' end;
  v_a      public.admin_audit_log;
begin
  if v_admin is null then raise exception 'UNAUTHENTICATED'; end if;
  if coalesce(auth.jwt() ->> 'user_role', '') <> 'admin' then raise exception 'FORBIDDEN'; end if;
  if not private.is_admin() then raise exception 'FORBIDDEN'; end if;

  if p_user_id is null or p_suspended is null or p_client_request_id is null then
    raise exception 'INVALID_ARGUMENT';
  end if;

  -- The profile lock serializes calls on one user, so a concurrent call with the
  -- same key sees the audit row below once it commits.
  perform 1 from public.profiles where id = p_user_id for update;
  if not found then raise exception 'INVALID_ARGUMENT'; end if;

  select * into v_a from public.admin_audit_log where client_request_id = p_client_request_id;
  if found then
    if v_a.action <> v_action or v_a.target_user_id is distinct from p_user_id then
      raise exception 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_a;
  end if;

  if p_suspended then
    update public.profiles set suspended_at = coalesce(suspended_at, now()) where id = p_user_id;
  else
    update public.profiles set suspended_at = null where id = p_user_id;
  end if;

  insert into public.admin_audit_log (admin_id, action, target_user_id, payload, client_request_id)
  values (v_admin, v_action, p_user_id, '{}'::jsonb, p_client_request_id)
  returning * into v_a;
  return v_a;
end;
$function$;

create function public.admin_review_kyc(p_submission_id uuid, p_approve boolean, p_client_request_id uuid)
 returns public.kyc_submissions
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_admin  uuid := auth.uid();
  v_action text := case when p_approve then 'kyc_approve' else 'kyc_reject' end;
  v_a      public.admin_audit_log;
  v_s      public.kyc_submissions;
begin
  if v_admin is null then raise exception 'UNAUTHENTICATED'; end if;
  if coalesce(auth.jwt() ->> 'user_role', '') <> 'admin' then raise exception 'FORBIDDEN'; end if;
  if not private.is_admin() then raise exception 'FORBIDDEN'; end if;

  if p_submission_id is null or p_approve is null or p_client_request_id is null then
    raise exception 'INVALID_ARGUMENT';
  end if;

  -- The row lock serializes reviews of one submission, so a concurrent call
  -- with the same key sees its audit row below once it commits.
  select * into v_s from public.kyc_submissions where id = p_submission_id for update;
  if not found then raise exception 'KYC_NOT_FOUND'; end if;

  select * into v_a from public.admin_audit_log where client_request_id = p_client_request_id;
  if found then
    if v_a.action <> v_action or v_a.target_id is distinct from p_submission_id then
      raise exception 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_s;
  end if;

  update public.kyc_submissions
     set status = case when p_approve then 'approved' else 'rejected' end::public.kyc_status,
         decided_at = now(), decided_by = v_admin
   where id = p_submission_id and status = 'pending'
  returning * into v_s;
  if not found then raise exception 'KYC_NOT_PENDING'; end if;

  insert into public.admin_audit_log (admin_id, action, target_user_id, target_id, payload, client_request_id)
  values (v_admin, v_action, v_s.user_id, v_s.id, '{}'::jsonb, p_client_request_id);
  return v_s;
end;
$function$;

create function public.admin_set_admin(p_user_id uuid, p_make_admin boolean, p_client_request_id uuid)
 returns public.admin_audit_log
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_admin  uuid := auth.uid();
  v_action text := case when p_make_admin then 'admin_grant' else 'admin_revoke' end;
  v_head   boolean;
  v_a      public.admin_audit_log;
begin
  if v_admin is null then raise exception 'UNAUTHENTICATED'; end if;
  if coalesce(auth.jwt() ->> 'user_role', '') <> 'admin' then raise exception 'FORBIDDEN'; end if;
  if not private.is_admin() then raise exception 'FORBIDDEN'; end if;
  if not private.is_head_admin() then raise exception 'FORBIDDEN'; end if;

  if p_user_id is null or p_make_admin is null or p_client_request_id is null then
    raise exception 'INVALID_ARGUMENT';
  end if;

  -- The profile lock serializes calls on one user (a grant has no user_roles row
  -- to lock yet), so a concurrent call with the same key sees the audit row below
  -- once it commits.
  perform 1 from public.profiles where id = p_user_id for update;
  if not found then raise exception 'INVALID_ARGUMENT'; end if;
  select is_head into v_head from public.user_roles
   where user_id = p_user_id and role = 'admin' for update;

  select * into v_a from public.admin_audit_log where client_request_id = p_client_request_id;
  if found then
    if v_a.action <> v_action or v_a.target_user_id is distinct from p_user_id then
      raise exception 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_a;
  end if;

  if p_make_admin then
    insert into public.user_roles (user_id, role, granted_by)
    values (p_user_id, 'admin', v_admin)
    on conflict (user_id, role) do nothing;
  else
    if v_head then raise exception 'HEAD_ADMIN_PROTECTED'; end if;
    delete from public.user_roles where user_id = p_user_id and role = 'admin';
  end if;

  insert into public.admin_audit_log (admin_id, action, target_user_id, payload, client_request_id)
  values (v_admin, v_action, p_user_id, '{}'::jsonb, p_client_request_id)
  returning * into v_a;
  return v_a;
end;
$function$;

create function public.admin_demote_head(p_user_id uuid, p_remove_admin boolean, p_client_request_id uuid)
 returns public.admin_audit_log
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_admin  uuid := auth.uid();
  v_action text := case when p_remove_admin then 'head_remove' else 'head_demote' end;
  v_head   boolean;
  v_owner  boolean;
  v_a      public.admin_audit_log;
begin
  if v_admin is null then raise exception 'UNAUTHENTICATED'; end if;
  if coalesce(auth.jwt() ->> 'user_role', '') <> 'admin' then raise exception 'FORBIDDEN'; end if;
  if not private.is_admin() then raise exception 'FORBIDDEN'; end if;
  if not private.is_owner() then raise exception 'FORBIDDEN'; end if;

  if p_user_id is null or p_remove_admin is null or p_client_request_id is null then
    raise exception 'INVALID_ARGUMENT';
  end if;

  -- The row lock serializes calls on one target, so a concurrent call with the same
  -- key sees the audit row below once the first commits (also after a remove, when
  -- the locked row no longer exists).
  select is_head, is_owner into v_head, v_owner from public.user_roles
   where user_id = p_user_id and role = 'admin' for update;

  select * into v_a from public.admin_audit_log where client_request_id = p_client_request_id;
  if found then
    if v_a.action <> v_action or v_a.target_user_id is distinct from p_user_id then
      raise exception 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_a;
  end if;

  if v_owner then raise exception 'OWNER_PROTECTED'; end if;
  if v_head is not true then raise exception 'NOT_HEAD_ADMIN'; end if;

  if p_remove_admin then
    delete from public.user_roles where user_id = p_user_id and role = 'admin';
  else
    update public.user_roles set is_head = false where user_id = p_user_id and role = 'admin';
  end if;

  insert into public.admin_audit_log (admin_id, action, target_user_id, payload, client_request_id)
  values (v_admin, v_action, p_user_id, '{}'::jsonb, p_client_request_id)
  returning * into v_a;
  return v_a;
end;
$function$;

revoke all on function public.admin_adjust_balance(uuid, public.wallet_account, bigint, uuid) from public, anon;
grant execute on function public.admin_adjust_balance(uuid, public.wallet_account, bigint, uuid) to authenticated;
revoke all on function public.admin_set_suspension(uuid, boolean, uuid) from public, anon;
grant execute on function public.admin_set_suspension(uuid, boolean, uuid) to authenticated;
revoke all on function public.admin_review_kyc(uuid, boolean, uuid) from public, anon;
grant execute on function public.admin_review_kyc(uuid, boolean, uuid) to authenticated;
revoke all on function public.admin_set_admin(uuid, boolean, uuid) from public, anon;
grant execute on function public.admin_set_admin(uuid, boolean, uuid) to authenticated;
revoke all on function public.admin_demote_head(uuid, boolean, uuid) from public, anon;
grant execute on function public.admin_demote_head(uuid, boolean, uuid) to authenticated;
