-- Support tickets: admin audit rows. Applied through the Management API.
-- Replaces support_reply and admin_support_close only; nothing else changes.
--   * A staff reply writes one admin_audit_log row 'support_reply' (target user the
--     ticket owner, target id the ticket, payload subject and message id, the
--     reply's client_request_id) in the same transaction. A user reply writes none.
--   * A close that changes the status writes one row 'support_close' (payload
--     subject and the previous status, no key, like kyc_photo_view). Closing a
--     closed ticket writes nothing.
--   * Replays return before any insert, so a retried reply writes one row.

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
  if v_staff then
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
  insert into public.admin_audit_log (admin_id, action, target_user_id, target_id, payload)
  values (v_admin, 'support_close', v_t.user_id, v_t.id,
          jsonb_build_object('subject', v_t.subject, 'from_status', v_prev));
  return v_t;
end;
$$;
