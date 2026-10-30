-- Forex Bills kind, in its own migration: a value added by ALTER TYPE ... ADD VALUE
-- cannot be used in the transaction that adds it, and 20261031100100_forex_money.sql
-- uses it. forex_refund is written for a draw (premium back) and a void (premium and
-- fee back). The premium is forex_margin and the settlement is forex_close, both from
-- the slice 1 enum.
alter type public.ledger_kind add value if not exists 'forex_refund';
