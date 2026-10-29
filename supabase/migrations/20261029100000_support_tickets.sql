-- =============================================================================
-- Support tickets and reply notifications. Applied through the Management API.
--
-- * Users open tickets and reply on their own tickets; admins read every ticket,
--   reply as AureonX Support and close tickets.
-- * Writes go only through the RPCs below (SELECT-only grants). They set
--   is_staff and the status: a user reply sets 'open', a staff reply sets
--   'answered', only an admin sets 'closed' and nobody replies on a closed ticket.
--   is_staff is never a client argument.
-- * A staff reply writes one notifications row for the ticket owner in the same
--   transaction. The app shows unread rows as toasts and marks them read.
-- * support_messages.author_id is not granted to authenticated, so no client
--   reads which admin answered.
-- * Suspension does not block support: a suspended user can still write.
-- =============================================================================

-- 1. Tables. Text is stored trimmed (spaces, tabs and line breaks).
create table public.support_tickets (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles (id) on delete cascade,
  topic             text not null check (topic in ('account', 'balance_funding', 'trading', 'verification', 'security', 'other')),
  subject           text not null check (char_length(subject) between 1 and 120 and subject = btrim(subject, E' \t\r\n')),
  status            text not null default 'open' check (status in ('open', 'answered', 'closed')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  client_request_id uuid not null,
  unique (user_id, client_request_id)
);
create index support_tickets_user_updated_idx on public.support_tickets (user_id, updated_at desc);
create index support_tickets_status_updated_idx on public.support_tickets (status, updated_at desc);

-- The first message of a ticket shares the ticket's client_request_id.
create table public.support_messages (
  id                uuid primary key default gen_random_uuid(),
  ticket_id         uuid not null references public.support_tickets (id) on delete cascade,
  author_id         uuid references auth.users (id) on delete set null,
  is_staff          boolean not null,
  body              text not null check (char_length(body) between 1 and 2000 and body = btrim(body, E' \t\r\n')),
  created_at        timestamptz not null default now(),
  client_request_id uuid not null,
  unique (ticket_id, client_request_id)
);
create index support_messages_ticket_created_idx on public.support_messages (ticket_id, created_at);
create index support_messages_author_idx on public.support_messages (author_id);

create table public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  kind       text not null check (kind in ('support_reply')),
  ticket_id  uuid references public.support_tickets (id) on delete cascade,
  created_at timestamptz not null default now(),
  read_at    timestamptz
);
create index notifications_unread_idx on public.notifications (user_id, created_at) where read_at is null;
create index notifications_ticket_idx on public.notifications (ticket_id);

-- 2. RLS: own rows, or every row for an admin (private.is_admin(), the live admin row).
alter table public.support_tickets enable row level security;
alter table public.support_messages enable row level security;
alter table public.notifications enable row level security;

create policy support_tickets_select on public.support_tickets for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));
create policy support_messages_select on public.support_messages for select to authenticated
  using (
    exists (select 1 from public.support_tickets t where t.id = ticket_id and t.user_id = (select auth.uid()))
    or (select private.is_admin())
  );
create policy notifications_select on public.notifications for select to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.support_tickets, public.support_messages, public.notifications from anon, authenticated;
grant select on public.support_tickets, public.notifications to authenticated;
grant select (id, ticket_id, is_staff, body, created_at) on public.support_messages to authenticated;

-- 3. support_create_ticket: the ticket and its first message in one call. The
-- profile lock serializes calls per user, so a replay sees the committed ticket.
create function public.support_create_ticket(
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
  return v_t;
end;
$$;

-- 4. support_reply: the owner replies as the user (status 'open'); anyone else
-- must be an admin (claim and live row) and replies as staff (status 'answered',
-- plus one notifications row for the owner). Others get SUPPORT_NOT_FOUND, so a
-- ticket id reveals nothing. The ticket row lock serializes replies per ticket.
create function public.support_reply(
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
  end if;
  return v_m;
end;
$$;

-- 5. admin_support_close: the only way to 'closed'. Closing a closed ticket
-- returns it unchanged.
create function public.admin_support_close(p_ticket_id uuid)
returns public.support_tickets
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t public.support_tickets;
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED'; end if;
  if coalesce(auth.jwt() ->> 'user_role', '') <> 'admin' then raise exception 'FORBIDDEN'; end if;
  if not private.is_admin() then raise exception 'FORBIDDEN'; end if;
  if p_ticket_id is null then raise exception 'INVALID_ARGUMENT'; end if;

  update public.support_tickets set status = 'closed', updated_at = now()
   where id = p_ticket_id and status <> 'closed'
  returning * into v_t;
  if not found then
    select * into v_t from public.support_tickets where id = p_ticket_id;
    if not found then raise exception 'SUPPORT_NOT_FOUND'; end if;
  end if;
  return v_t;
end;
$$;

-- 6. mark_notifications_read: own unread rows only. Returns how many changed.
create function public.mark_notifications_read(p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_n   integer;
begin
  if v_uid is null then raise exception 'UNAUTHENTICATED'; end if;
  update public.notifications set read_at = now()
   where user_id = v_uid and id = any (coalesce(p_ids, '{}')) and read_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- 7. Realtime: new notifications reach the owner (RLS per subscriber).
alter publication supabase_realtime add table public.notifications;

-- 8. Grants. New functions are not executable by default.
revoke all on function public.support_create_ticket(text, text, text, uuid) from public, anon;
revoke all on function public.support_reply(uuid, text, uuid) from public, anon;
revoke all on function public.admin_support_close(uuid) from public, anon;
revoke all on function public.mark_notifications_read(uuid[]) from public, anon;
grant execute on function public.support_create_ticket(text, text, text, uuid) to authenticated;
grant execute on function public.support_reply(uuid, text, uuid) to authenticated;
grant execute on function public.admin_support_close(uuid) to authenticated;
grant execute on function public.mark_notifications_read(uuid[]) to authenticated;
