-- Spot limit orders: let signed-in users call the two RPCs.
-- 20261031180000_spot_limit_orders.sql held both back (owner decision) until the client could
-- read open and canceled orders. The Limit screen ships with this migration, so apply it
-- together with that deploy. Nothing else changes here.
grant execute on function public.spot_limit_order(text, public.order_side, text, text, uuid) to authenticated;
grant execute on function public.spot_cancel_order(uuid) to authenticated;
