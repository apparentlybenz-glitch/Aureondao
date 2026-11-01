-- =============================================================================
-- Per-account Withdraw page restriction.
--
-- * profiles.withdraw_restricted_at (null when allowed). Users read it under the
--   existing profiles_select policy (the table grant is SELECT only, so there is
--   no client write).
-- * public.admin_set_withdraw_restriction(user, restricted, client_request_id):
--   the admin_set_suspension checks (claim, live admin row), idempotent on the
--   key through the audit row, always writes one audit row (withdraw_restrict or
--   withdraw_unrestrict, payload '{}').
-- * The Withdraw page is display only today (no withdrawal RPC exists), so this
--   flag gates the page in the client. A future withdrawal RPC must check it.
-- =============================================================================

alter table public.profiles add column withdraw_restricted_at timestamptz;

create function public.admin_set_withdraw_restriction(p_user_id uuid, p_restricted boolean, p_client_request_id uuid)
 returns public.admin_audit_log
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_admin  uuid := auth.uid();
  v_action text := case when p_restricted then 'withdraw_restrict' else 'withdraw_unrestrict' end;
  v_a      public.admin_audit_log;
begin
  if v_admin is null then raise exception 'UNAUTHENTICATED'; end if;
  if coalesce(auth.jwt() ->> 'user_role', '') <> 'admin' then raise exception 'FORBIDDEN'; end if;
  if not private.is_admin() then raise exception 'FORBIDDEN'; end if;

  if p_user_id is null or p_restricted is null or p_client_request_id is null then
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

  if p_restricted then
    update public.profiles set withdraw_restricted_at = coalesce(withdraw_restricted_at, now()) where id = p_user_id;
  else
    update public.profiles set withdraw_restricted_at = null where id = p_user_id;
  end if;

  insert into public.admin_audit_log (admin_id, action, target_user_id, payload, client_request_id)
  values (v_admin, v_action, p_user_id, '{}'::jsonb, p_client_request_id)
  returning * into v_a;
  return v_a;
end;
$function$;

revoke all on function public.admin_set_withdraw_restriction(uuid, boolean, uuid) from public, anon;
grant execute on function public.admin_set_withdraw_restriction(uuid, boolean, uuid) to authenticated;
