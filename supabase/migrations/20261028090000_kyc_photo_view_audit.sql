-- =============================================================================
-- Slice 8 follow-up: one audit row per admin view of a KYC photo.
-- Applied through the Management API.
--
-- admin/kyc calls admin_log_kyc_photo_view immediately before it creates the
-- signed URL and creates no URL when this call fails. Same checks as
-- admin_review_kyc (claim, aal2, live admin row); no idempotency key, because
-- every view is its own event.
-- =============================================================================

create function public.admin_log_kyc_photo_view(p_submission_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

revoke all on function public.admin_log_kyc_photo_view(uuid) from public, anon;
grant execute on function public.admin_log_kyc_photo_view(uuid) to authenticated;
