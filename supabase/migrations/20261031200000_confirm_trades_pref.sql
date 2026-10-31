-- Per-account preference: show the trade confirm dialog before a Spot or Options order.
-- Read under the existing profiles_select policy (the table-level SELECT grant covers the
-- new column); written only through set_confirm_trades. Not a money path: no balance,
-- order or position is touched, so suspension does not block it.

alter table public.profiles
  add column confirm_trades boolean not null default true;

create function public.set_confirm_trades(p_value boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_value boolean;
begin
  if v_uid is null then raise exception 'UNAUTHENTICATED'; end if;
  if p_value is null then raise exception 'INVALID_ARGUMENT'; end if;
  update public.profiles
     set confirm_trades = p_value
   where id = v_uid
  returning confirm_trades into v_value;
  if not found then raise exception 'PROFILE_NOT_FOUND'; end if;
  return v_value;
end;
$$;

revoke all on function public.set_confirm_trades(boolean) from public, anon;
grant execute on function public.set_confirm_trades(boolean) to authenticated;
