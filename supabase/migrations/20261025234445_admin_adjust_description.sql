-- =============================================================================
-- Slice 2: admin adjustments show "Balance adjustment" in Bills (owner decision).
-- The admin's reason stays in admin_audit_log only. Applied through the
-- Management API.
-- =============================================================================
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
  -- The user's Bills row says "Balance adjustment"; the reason is not copied.
  perform private.wallet_apply(v_wallet, p_delta_cents, 0,
                               case when p_delta_cents > 0 then 'admin_credit'::public.ledger_kind
                                    else 'admin_debit'::public.ledger_kind end,
                               'admin_adjustment', v_a.id, p_actor_id => v_admin,
                               p_memo => 'Balance adjustment');
  return v_a;
end;
$$;
