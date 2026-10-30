-- =============================================================================
-- Owner tier above head admin. Applied through the Management API.
--
-- * user_roles.is_owner marks the owner, who is always a head admin (CHECK). Only the
--   owner can demote a head admin to admin or remove a head admin's admin access
--   (admin_demote_head below). The owner row itself cannot be demoted or removed in the
--   app, by anyone, including the owner (OWNER_PROTECTED).
-- * Nothing here, and nothing anywhere else, sets is_head or is_owner to true: no
--   function, trigger, policy or grant. admin_demote_head writes is_head = false only.
--   authenticated keeps SELECT only on user_roles; the table-level SELECT grant already
--   covers the new column and the user_roles_select policy is unchanged.
-- * This migration sets no owner. The owner is set by hand:
--     update public.user_roles set is_owner = true where user_id = '<uuid>' and role = 'admin' and is_head;
-- * admin_set_admin is unchanged: it still refuses to revoke a head admin
--   (HEAD_ADMIN_PROTECTED), the owner included. The owner uses admin_demote_head for heads.
-- * custom_access_token_hook, private.is_admin() and private.is_head_admin() are unchanged.
-- * admin_audit_log.action has no CHECK, so the new actions head_demote and head_remove
--   need no change there.
-- =============================================================================

alter table public.user_roles add column is_owner boolean not null default false;
alter table public.user_roles add constraint user_roles_owner_is_head check (not is_owner or is_head);

create or replace function private.is_owner()
 returns boolean
 language sql
 stable security definer
 set search_path to ''
as $function$
  select exists (
       select 1 from public.user_roles r
       where r.user_id = (select auth.uid()) and r.role = 'admin' and r.is_head and r.is_owner
     );
$function$;

create or replace function public.admin_demote_head(p_user_id uuid, p_remove_admin boolean, p_reason text, p_client_request_id uuid)
 returns public.admin_audit_log
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_admin  uuid := auth.uid();
  v_reason text := nullif(trim(p_reason), '');
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
  if coalesce(char_length(v_reason), 0) not between 3 and 200 then raise exception 'NOTE_REQUIRED'; end if;

  -- The row lock serializes calls on one target, so a concurrent call with the same
  -- key sees the audit row below once the first commits (also after a remove, when
  -- the locked row no longer exists).
  select is_head, is_owner into v_head, v_owner from public.user_roles
   where user_id = p_user_id and role = 'admin' for update;

  select * into v_a from public.admin_audit_log where client_request_id = p_client_request_id;
  if found then
    if v_a.action <> v_action or v_a.target_user_id is distinct from p_user_id
       or (v_a.payload ->> 'reason') is distinct from v_reason then
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
  values (v_admin, v_action, p_user_id, jsonb_build_object('reason', v_reason), p_client_request_id)
  returning * into v_a;
  return v_a;
end;
$function$;

revoke all on function private.is_owner() from public, anon, authenticated;
revoke all on function public.admin_demote_head(uuid, boolean, text, uuid) from public, anon;
grant execute on function public.admin_demote_head(uuid, boolean, text, uuid) to authenticated;
