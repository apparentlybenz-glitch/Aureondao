-- Support tickets: admin notifications. Applied through the Management API.
-- Replaces support_create_ticket, support_reply and admin_support_close; the staff
-- reply's owner notification and audit row are unchanged.
--   * A new ticket writes one notifications row 'support_new_ticket' and a user
--     reply one row 'support_user_reply' for every live admin (a user_roles admin
--     row) except the author, in the same transaction. Both carry ticket_id like
--     'support_reply'. Replays return before any insert, so a retry adds no rows.
--   * A staff reply and a close that changes the status mark every unread admin
--     row ('support_new_ticket', 'support_user_reply') for that ticket read, for
--     all admins, in the same transaction.
--   * notifications RLS is unchanged: each admin reads only their own rows.
--   * The two private helpers run only inside these SECURITY DEFINER functions.

alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('support_reply', 'support_new_ticket', 'support_user_reply'));

create function private.notify_support_admins(p_ticket_id uuid, p_kind text, p_author uuid)
returns void
language sql
set search_path = ''
as $$
  insert into public.notifications (user_id, kind, ticket_id)
  select r.user_id, p_kind, p_ticket_id
    from public.user_roles r
    join public.profiles p on p.id = r.user_id
   where r.role = 'admin' and r.user_id <> p_author;
$$;

create function private.clear_support_admin_notifications(p_ticket_id uuid)
returns void
language sql
set search_path = ''
as $$
  update public.notifications set read_at = now()
   where ticket_id = p_ticket_id and read_at is null
     and kind in ('support_new_ticket', 'support_user_reply');
$$;

revoke all on function private.notify_support_admins(uuid, text, uuid) from public, anon, authenticated;
revoke all on function private.clear_support_admin_notifications(uuid) from public, anon, authenticated;

create or replace function public.support_create_ticket(
  p_topic             text,
  p_subject           text,
  p_body              text,
  p_client_request_id uuid
)
returns public.support_tickets
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_subject text := btrim(p_subject, E' \t\r\n');
  v_body    text := btrim(p_body, E' \t\r\n');
  v_t       public.support_tickets;
begin
  if v_uid is null then raise exception 'UNAUTHENTICATED'; end if;
  if p_client_request_id is null then raise exception 'INVALID_ARGUMENT'; end if;

  perform 1 from public.profiles where id = v_uid for update;
  if not found then raise exception 'PROFILE_NOT_FOUND'; end if;

  select * into v_t from public.support_tickets where user_id = v_uid and client_request_id = p_client_request_id;
  if found then
    if v_t.topic is distinct from p_topic or v_t.subject is distinct from v_subject
       or not exists (select 1 from public.support_messages m
                       where m.ticket_id = v_t.id and m.client_request_id = p_client_request_id and m.body = v_body) then
      raise exception 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_t;
  end if;

  if p_topic is null or p_topic not in ('account', 'balance_funding', 'trading', 'verification', 'security', 'other') then
    raise exception 'SUPPORT_INVALID_TOPIC';
  end if;
  if coalesce(char_length(v_subject), 0) not between 1 and 120 then raise exception 'SUPPORT_INVALID_SUBJECT'; end if;
  if coalesce(char_length(v_body), 0) not between 1 and 2000 then raise exception 'SUPPORT_INVALID_BODY'; end if;

  insert into public.support_tickets (user_id, topic, subject, client_request_id)
  values (v_uid, p_topic, v_subject, p_client_request_id)
  returning * into v_t;
  insert into public.support_messages (ticket_id, author_id, is_staff, body, client_request_id)
  values (v_t.id, v_uid, false, v_body, p_client_request_id);
  perform private.notify_support_admins(v_t.id, 'support_new_ticket', v_uid);
  return v_t;
end;
$$;

create or replace function public.support_reply(
  p_ticket_id         uuid,
  p_body              text,
  p_client_request_id uuid
)
returns public.support_messages
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_body  text := btrim(p_body, E' \t\r\n');
  v_staff boolean;
  v_t     public.support_tickets;
  v_m     public.support_messages;
begin
  if v_uid is null then raise exception 'UNAUTHENTICATED'; end if;
  if p_ticket_id is null or p_client_request_id is null then raise exception 'INVALID_ARGUMENT'; end if;

  select * into v_t from public.support_tickets where id = p_ticket_id for update;
  if not found then raise exception 'SUPPORT_NOT_FOUND'; end if;
  v_staff := v_t.user_id <> v_uid;
  if v_staff and (coalesce(auth.jwt() ->> 'user_role', '') <> 'admin' or not private.is_admin()) then
    raise exception 'SUPPORT_NOT_FOUND';
  end if;

  select * into v_m from public.support_messages where ticket_id = p_ticket_id and client_request_id = p_client_request_id;
  if found then
    if v_m.body is distinct from v_body or v_m.author_id is distinct from v_uid then
      raise exception 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_m;
  end if;

  if v_t.status = 'closed' then raise exception 'SUPPORT_CLOSED'; end if;
  if coalesce(char_length(v_body), 0) not between 1 and 2000 then raise exception 'SUPPORT_INVALID_BODY'; end if;

  insert into public.support_messages (ticket_id, author_id, is_staff, body, client_request_id)
  values (p_ticket_id, v_uid, v_staff, v_body, p_client_request_id)
  returning * into v_m;
  update public.support_tickets
     set status = case when v_staff then 'answered' else 'open' end, updated_at = now()
   where id = p_ticket_id;
  if not v_staff then
    perform private.notify_support_admins(v_t.id, 'support_user_reply', v_uid);
  end if;
  if v_staff then
    perform private.clear_support_admin_notifications(v_t.id);
    insert into public.notifications (user_id, kind, ticket_id) values (v_t.user_id, 'support_reply', v_t.id);
    insert into public.admin_audit_log (admin_id, action, target_user_id, target_id, payload, client_request_id)
    values (v_uid, 'support_reply', v_t.user_id, v_t.id,
            jsonb_build_object('subject', v_t.subject, 'message_id', v_m.id), p_client_request_id);
  end if;
  return v_m;
end;
$$;

create or replace function public.admin_support_close(p_ticket_id uuid)
returns public.support_tickets
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin uuid := auth.uid();
  v_prev  text;
  v_t     public.support_tickets;
begin
  if v_admin is null then raise exception 'UNAUTHENTICATED'; end if;
  if coalesce(auth.jwt() ->> 'user_role', '') <> 'admin' then raise exception 'FORBIDDEN'; end if;
  if not private.is_admin() then raise exception 'FORBIDDEN'; end if;
  if p_ticket_id is null then raise exception 'INVALID_ARGUMENT'; end if;

  select * into v_t from public.support_tickets where id = p_ticket_id for update;
  if not found then raise exception 'SUPPORT_NOT_FOUND'; end if;
  if v_t.status = 'closed' then return v_t; end if;

  v_prev := v_t.status;
  update public.support_tickets set status = 'closed', updated_at = now()
   where id = p_ticket_id
  returning * into v_t;
  perform private.clear_support_admin_notifications(v_t.id);
  insert into public.admin_audit_log (admin_id, action, target_user_id, target_id, payload)
  values (v_admin, 'support_close', v_t.user_id, v_t.id,
          jsonb_build_object('subject', v_t.subject, 'from_status', v_prev));
  return v_t;
end;
$$;
