-- =============================================================================
-- Admin account deletion.
--
-- public.admin_delete_user(user, client_request_id) deletes the auth user. Every
-- table that references the user cascades (profile, wallets, ledger, orders,
-- holdings, option and forex positions, favorites, support tickets and messages'
-- tickets, notifications, KYC submissions, user_roles) or sets the reference null
-- (admin_audit_log, ledger.actor_id, support_messages.author_id, ...), so one
-- delete erases the account and its money history (the Day 6 ledger cascade
-- decision). KYC photos in the private bucket are removed by the daily
-- kyc-cleanup job (folders whose user no longer exists).
--
-- * Checks as admin_set_suspension (claim, live admin row).
-- * An admin cannot delete themselves (CANNOT_DELETE_SELF) or any account that
--   has an admin row (ADMIN_PROTECTED): remove admin access first.
-- * One audit row `delete_user` is written before the delete. Its target_user_id
--   goes null with the user, so the payload keeps user_id, uid and email.
-- * Idempotent on the key through the audit row, also after the deletion.
-- =============================================================================

create function public.admin_delete_user(p_user_id uuid, p_client_request_id uuid)
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

revoke all on function public.admin_delete_user(uuid, uuid) from public, anon;
grant execute on function public.admin_delete_user(uuid, uuid) to authenticated;
