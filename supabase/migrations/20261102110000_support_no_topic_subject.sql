-- Support tickets: no topic and no subject input. Applied through the Management API.
--   * support_tickets.topic is dropped; existing topic values are discarded.
--   * support_tickets.subject stays (ticket title, toasts, audit payloads) and is
--     derived by the server: the message with each whitespace run made one space,
--     cut to 120 characters and trimmed. Existing tickets keep their subject.
--   * support_create_ticket takes only the message and the idempotency key. The
--     old four-argument signature is dropped. Everything else is carried forward
--     from 20261029200000_support_admin_notifications.sql: the profile lock, the
--     replay on the key (now compared on the first message body only), the first
--     message sharing the ticket's client_request_id and the admin fan-out.

drop function public.support_create_ticket(text, text, text, uuid);

alter table public.support_tickets drop column topic;

create function public.support_create_ticket(
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
  v_body    text := btrim(p_body, E' \t\r\n');
  v_subject text;
  v_t       public.support_tickets;
begin
  if v_uid is null then raise exception 'UNAUTHENTICATED'; end if;
  if p_client_request_id is null then raise exception 'INVALID_ARGUMENT'; end if;

  perform 1 from public.profiles where id = v_uid for update;
  if not found then raise exception 'PROFILE_NOT_FOUND'; end if;

  select * into v_t from public.support_tickets where user_id = v_uid and client_request_id = p_client_request_id;
  if found then
    if not exists (select 1 from public.support_messages m
                    where m.ticket_id = v_t.id and m.client_request_id = p_client_request_id and m.body = v_body) then
      raise exception 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_t;
  end if;

  if coalesce(char_length(v_body), 0) not between 1 and 2000 then raise exception 'SUPPORT_INVALID_BODY'; end if;
  -- Empty when the body is only whitespace the trim above keeps (a no-break space).
  v_subject := btrim(left(regexp_replace(v_body, '\s+', ' ', 'g'), 120));
  if v_subject = '' then raise exception 'SUPPORT_INVALID_BODY'; end if;

  insert into public.support_tickets (user_id, subject, client_request_id)
  values (v_uid, v_subject, p_client_request_id)
  returning * into v_t;
  insert into public.support_messages (ticket_id, author_id, is_staff, body, client_request_id)
  values (v_t.id, v_uid, false, v_body, p_client_request_id);
  perform private.notify_support_admins(v_t.id, 'support_new_ticket', v_uid);
  return v_t;
end;
$$;

revoke all on function public.support_create_ticket(text, uuid) from public, anon;
grant execute on function public.support_create_ticket(text, uuid) to authenticated;
