-- =============================================================================
-- Head admin. Applied through the Management API.
--
-- * user_roles.is_head marks a head admin. Only a head admin can grant or revoke
--   admin access for other users (admin_set_admin below). A head admin is created
--   only by hand in SQL: no function, trigger, policy or grant written here (or
--   anywhere else) sets is_head, and authenticated keeps SELECT only on user_roles.
--   admin_set_admin inserts rows with is_head at its default (false) and refuses to
--   delete a row with is_head true (HEAD_ADMIN_PROTECTED), so a head admin cannot be
--   removed in the app and at least one admin always remains.
-- * This migration sets no head admin. The first one is set by hand:
--     update public.user_roles set is_head = true where user_id = '<uuid>' and role = 'admin';
-- * custom_access_token_hook reads only user_id and role, and private.is_admin() only
--   the admin row, so neither changes and both keep working with the new column.
-- * The table-level SELECT grant to authenticated already covers the new column; the
--   existing user_roles_select policy (own row, or any row for an admin) is unchanged.
-- * admin_audit_log.action has no CHECK, so the new actions admin_grant and
--   admin_revoke need no change there.
-- =============================================================================

alter table public.user_roles add column is_head boolean not null default false;

create or replace function private.is_head_admin()
 returns boolean
 language sql
 stable security definer
 set search_path to ''
as $function$
  select exists (
       select 1 from public.user_roles r
       where r.user_id = (select auth.uid()) and r.role = 'admin' and r.is_head
     );
$function$;

create or replace function public.admin_set_admin(p_user_id uuid, p_make_admin boolean, p_reason text, p_client_request_id uuid)
 returns public.admin_audit_log
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_admin  uuid := auth.uid();
  v_reason text := nullif(trim(p_reason), '');
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
  if coalesce(char_length(v_reason), 0) not between 3 and 200 then raise exception 'NOTE_REQUIRED'; end if;

  -- The profile lock serializes calls on one user (a grant has no user_roles row
  -- to lock yet), so a concurrent call with the same key sees the audit row below
  -- once it commits.
  perform 1 from public.profiles where id = p_user_id for update;
  if not found then raise exception 'INVALID_ARGUMENT'; end if;
  select is_head into v_head from public.user_roles
   where user_id = p_user_id and role = 'admin' for update;

  select * into v_a from public.admin_audit_log where client_request_id = p_client_request_id;
  if found then
    if v_a.action <> v_action or v_a.target_user_id is distinct from p_user_id
       or (v_a.payload ->> 'reason') is distinct from v_reason then
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
  values (v_admin, v_action, p_user_id, jsonb_build_object('reason', v_reason), p_client_request_id)
  returning * into v_a;
  return v_a;
end;
$function$;

revoke all on function private.is_head_admin() from public, anon, authenticated;
revoke all on function public.admin_set_admin(uuid, boolean, text, uuid) from public, anon;
grant execute on function public.admin_set_admin(uuid, boolean, text, uuid) to authenticated;
