-- ENA, WLD and ONDO have no official branded icon in the vendored icon library, so
-- their Spot and Options pairs are switched off. The rows stay: nothing is deleted,
-- no other column or table changes, and running this twice changes nothing more.
-- Every user-facing read of markets filters enabled = true, and spot_market_order
-- and open_option already raise MARKET_DISABLED for a disabled market.
update public.markets
set enabled = false
where base in ('ENA', 'WLD', 'ONDO')
  and enabled;
