-- =============================================================================
-- Slice 8: KYC with one photo per submission. Applied through the Management API.
--
-- Owner decisions (slice 8):
--   * KYC gates nothing. It is a status shown on Profile, Verification and Admin.
--   * Four steps (country and ID type, personal info, one document photo, review).
--     No selfie and no document number.
--   * Photos live in the private bucket kyc-photos (JPEG, PNG or WebP, 5 MB).
--     A user uploads to and reads only their own folder ({user_id}/...); an admin
--     reads every file through short-lived signed URLs. No client update or delete.
--   * An admin approves, or rejects with a reason. A rejected or approved user can
--     submit again; the new submission is pending. At most one pending per user.
--   * Retention: submissions and photos are kept until the account is deleted.
--     Submissions cascade with the profile; the kyc-cleanup Edge Function removes
--     the Storage files of deleted users daily (Storage rows cannot be deleted in
--     SQL: storage.protect_delete blocks it, so removal goes through the Storage API).
--   * profiles.kyc_status and profiles.country are dropped: the latest submission
--     (public.kyc_current) is the only source for both. update_profile loses its
--     p_country argument.
-- =============================================================================

-- 1. Retire the slice 1 columns and enum, then the slice 8 enums.
alter table public.profiles drop column kyc_status, drop column country;
drop type public.kyc_status;

create type public.kyc_status        as enum ('pending', 'approved', 'rejected');
create type public.kyc_document_type as enum ('passport', 'national_id', 'drivers_license');

drop function public.update_profile(text, text, text);
create function public.update_profile(p_nickname text, p_phone text)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_p   public.profiles;
begin
  if v_uid is null then raise exception 'UNAUTHENTICATED'; end if;
  update public.profiles
     set nickname = coalesce(nullif(trim(p_nickname), ''), nickname),
         phone    = nullif(trim(p_phone), '')
   where id = v_uid
  returning * into v_p;
  if not found then raise exception 'PROFILE_NOT_FOUND'; end if;
  return v_p;
end;
$$;

-- 2. ISO 3166-1 alpha-2 codes. Keep in step with src/lib/countries.ts
-- (src/lib/countries.test.mjs compares the two lists).
create function private.is_country(p_code text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_code = any (array[
    'AD','AE','AF','AG','AI','AL','AM','AO','AQ','AR','AS','AT','AU','AW','AX','AZ',
    'BA','BB','BD','BE','BF','BG','BH','BI','BJ','BL','BM','BN','BO','BQ','BR','BS','BT','BV','BW','BY','BZ',
    'CA','CC','CD','CF','CG','CH','CI','CK','CL','CM','CN','CO','CR','CU','CV','CW','CX','CY','CZ',
    'DE','DJ','DK','DM','DO','DZ','EC','EE','EG','EH','ER','ES','ET','FI','FJ','FK','FM','FO','FR',
    'GA','GB','GD','GE','GF','GG','GH','GI','GL','GM','GN','GP','GQ','GR','GS','GT','GU','GW','GY',
    'HK','HM','HN','HR','HT','HU','ID','IE','IL','IM','IN','IO','IQ','IR','IS','IT','JE','JM','JO','JP',
    'KE','KG','KH','KI','KM','KN','KP','KR','KW','KY','KZ','LA','LB','LC','LI','LK','LR','LS','LT','LU','LV','LY',
    'MA','MC','MD','ME','MF','MG','MH','MK','ML','MM','MN','MO','MP','MQ','MR','MS','MT','MU','MV','MW','MX','MY','MZ',
    'NA','NC','NE','NF','NG','NI','NL','NO','NP','NR','NU','NZ','OM',
    'PA','PE','PF','PG','PH','PK','PL','PM','PN','PR','PS','PT','PW','PY','QA','RE','RO','RS','RU','RW',
    'SA','SB','SC','SD','SE','SG','SH','SI','SJ','SK','SL','SM','SN','SO','SR','SS','ST','SV','SX','SY','SZ',
    'TC','TD','TF','TG','TH','TJ','TK','TL','TM','TN','TO','TR','TT','TV','TW','TZ',
    'UA','UG','UM','US','UY','UZ','VA','VC','VE','VG','VI','VN','VU','WF','WS','YE','YT','ZA','ZM','ZW'
  ]::text[]);
$$;

-- 3. Submissions. The date of birth is checked against the submission time, so
-- the row stays valid as time passes.
create table public.kyc_submissions (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profiles (id) on delete cascade,
  country            text not null check (private.is_country(country)),
  document_type      public.kyc_document_type not null,
  full_name          text not null check (char_length(full_name) between 2 and 100),
  date_of_birth      date not null,
  city               text not null check (char_length(city) between 1 and 80),
  photo_path         text not null,
  status             public.kyc_status not null default 'pending',
  rejection_reason   text,
  submitted_at       timestamptz not null default now(),
  decided_at         timestamptz,
  decided_by         uuid references auth.users (id) on delete set null,
  client_request_id  uuid not null,
  unique (user_id, client_request_id),
  constraint kyc_dob_chk check (
    date_of_birth > date '1900-01-01'
    and date_of_birth <= (submitted_at at time zone 'UTC')::date - interval '18 years'
  ),
  constraint kyc_photo_path_chk check (starts_with(photo_path, user_id::text || '/')),
  constraint kyc_reason_chk check (
    (status = 'rejected') = (rejection_reason is not null)
    and (rejection_reason is null or char_length(rejection_reason) between 3 and 200)
  ),
  constraint kyc_decided_chk check ((status = 'pending') = (decided_at is null))
);
create unique index kyc_one_pending_idx on public.kyc_submissions (user_id) where status = 'pending';
create index kyc_user_submitted_idx on public.kyc_submissions (user_id, submitted_at desc);
-- The admin list: enum order puts pending first.
create index kyc_status_submitted_idx on public.kyc_submissions (status, submitted_at desc);
create index kyc_decided_by_idx on public.kyc_submissions (decided_by);

alter table public.kyc_submissions enable row level security;
create policy kyc_submissions_select on public.kyc_submissions for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));
revoke all on public.kyc_submissions from anon, authenticated;
grant select on public.kyc_submissions to authenticated;

-- 4. Current state: each user's latest submission. No row means not started.
-- security_invoker keeps the kyc_submissions policy in force.
create view public.kyc_current with (security_invoker = true) as
select distinct on (user_id) *
  from public.kyc_submissions
 order by user_id, submitted_at desc, id desc;
revoke all on public.kyc_current from anon, authenticated;
grant select on public.kyc_current to authenticated;

-- 5. Private bucket. The Storage API enforces the size and type limits.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('kyc-photos', 'kyc-photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp']);

-- 6. Storage policies. Own folder only for insert and select; admins select all.
-- No update or delete policy: clients cannot overwrite or remove a photo.
create policy kyc_photos_insert_own on storage.objects for insert to authenticated
  with check (bucket_id = 'kyc-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy kyc_photos_select_own on storage.objects for select to authenticated
  using (bucket_id = 'kyc-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy kyc_photos_select_admin on storage.objects for select to authenticated
  using (bucket_id = 'kyc-photos' and (select private.is_admin()));

-- 7. submit_kyc. The profile lock serializes calls per user, so the replay
-- lookup and the one-pending rule see every committed submission.
create function public.submit_kyc(
  p_country           text,
  p_document_type     public.kyc_document_type,
  p_full_name         text,
  p_date_of_birth     date,
  p_city              text,
  p_photo_path        text,
  p_client_request_id uuid
)
returns public.kyc_submissions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_country text := upper(trim(p_country));
  v_name    text := trim(p_full_name);
  v_city    text := trim(p_city);
  v_s       public.kyc_submissions;
begin
  if v_uid is null then raise exception 'UNAUTHENTICATED'; end if;
  if p_country is null or p_document_type is null or p_full_name is null or p_date_of_birth is null
     or p_city is null or p_photo_path is null or p_client_request_id is null then
    raise exception 'INVALID_ARGUMENT';
  end if;

  perform 1 from public.profiles where id = v_uid for update;
  if not found then raise exception 'PROFILE_NOT_FOUND'; end if;

  select * into v_s from public.kyc_submissions
   where user_id = v_uid and client_request_id = p_client_request_id;
  if found then
    if v_s.country <> v_country or v_s.document_type <> p_document_type or v_s.full_name <> v_name
       or v_s.date_of_birth <> p_date_of_birth or v_s.city <> v_city or v_s.photo_path <> p_photo_path then
      raise exception 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_s;
  end if;

  if not private.is_country(v_country) then raise exception 'KYC_INVALID_COUNTRY'; end if;
  if char_length(v_name) not between 2 and 100 then raise exception 'KYC_INVALID_NAME'; end if;
  if p_date_of_birth <= date '1900-01-01'
     or p_date_of_birth > (now() at time zone 'UTC')::date - interval '18 years' then
    raise exception 'KYC_INVALID_DOB';
  end if;
  if char_length(v_city) not between 1 and 80 then raise exception 'KYC_INVALID_CITY'; end if;
  if not starts_with(p_photo_path, v_uid::text || '/') or p_photo_path like '%..%' then
    raise exception 'KYC_PATH_INVALID';
  end if;
  if not exists (select 1 from storage.objects where bucket_id = 'kyc-photos' and name = p_photo_path) then
    raise exception 'KYC_FILE_MISSING';
  end if;
  if exists (select 1 from public.kyc_submissions where user_id = v_uid and status = 'pending') then
    raise exception 'KYC_PENDING';
  end if;

  insert into public.kyc_submissions (user_id, country, document_type, full_name, date_of_birth, city,
                                      photo_path, client_request_id)
  values (v_uid, v_country, p_document_type, v_name, p_date_of_birth, v_city, p_photo_path, p_client_request_id)
  returning * into v_s;
  return v_s;
end;
$$;

-- 8. admin_review_kyc: the same checks as admin_adjust_balance (claim, aal2, live
-- admin row). Acts only on a pending submission (guarded transition); a reject
-- needs a reason of 3 to 200 characters. Idempotent on the key through the audit
-- row; every decision writes one audit row (kyc_approve or kyc_reject).
create function public.admin_review_kyc(
  p_submission_id     uuid,
  p_approve           boolean,
  p_reason            text,
  p_client_request_id uuid
)
returns public.kyc_submissions
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

-- 9. Cleanup support for the kyc-cleanup Edge Function (service_role only):
-- which of these top-level folder names are user ids with no auth.users row.
-- Names that are not uuids are never returned, so those folders are left alone.
create function public.kyc_orphan_folders(p_folders text[])
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(f order by f), '{}')
    from unnest(p_folders) as f
   where f ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     and not exists (select 1 from auth.users u where u.id = f::uuid);
$$;

-- pg_cron calls this daily; it posts to kyc-cleanup with its own shared secret,
-- reading the URL and the secret from Vault like private.price_tick.
create function private.kyc_cleanup_tick()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url    text;
  v_secret text;
begin
  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'kyc_cleanup_secret';
  if v_url is null or v_secret is null then
    raise log 'aureonx kyc_cleanup_tick: vault secrets project_url / kyc_cleanup_secret missing';
    return;
  end if;
  perform net.http_post(
    url                  := v_url || '/functions/v1/kyc-cleanup',
    headers              := jsonb_build_object('Content-Type', 'application/json',
                                               'x-aureonx-cron-secret', v_secret),
    body                 := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
end;
$$;

select cron.schedule('aureonx-kyc-cleanup', '43 2 * * *', $c$ select private.kyc_cleanup_tick(); $c$);

-- 10. Grants. New functions are not executable by default.
revoke all on function private.is_country(text) from public, anon, authenticated;
revoke all on function private.kyc_cleanup_tick() from public, anon, authenticated;
revoke all on function public.update_profile(text, text) from public, anon;
revoke all on function public.submit_kyc(text, public.kyc_document_type, text, date, text, text, uuid) from public, anon;
revoke all on function public.admin_review_kyc(uuid, boolean, text, uuid) from public, anon;
revoke all on function public.kyc_orphan_folders(text[]) from public, anon, authenticated;
grant execute on function public.update_profile(text, text) to authenticated;
grant execute on function public.submit_kyc(text, public.kyc_document_type, text, date, text, text, uuid) to authenticated;
grant execute on function public.admin_review_kyc(uuid, boolean, text, uuid) to authenticated;
grant execute on function public.kyc_orphan_folders(text[]) to service_role;
