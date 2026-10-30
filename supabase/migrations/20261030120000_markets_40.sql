-- 20 more USDT pairs (40 enabled markets in all) and Options on 38 of them.
--
-- Checked live on data-api.binance.vision on 2026-10-30: every symbol below has
-- exchangeInfo status TRADING, a 24hr ticker with bid and ask above 0 and a
-- non-zero quote volume, and a -USDT ticker on KuCoin allTickers (the fallback
-- source for the price feed and /md/v1/tickers). No reserve was needed.
--
-- Conventions of the seeded rows: price_decimals is the decimal count of the
-- Vision tickSize, qty_decimals the decimal count of the LOT_SIZE stepSize
-- (a power of ten, equal to minQty on all 20), min_notional_cents the
-- NOTIONAL minNotional in cents (5 USDT, 1 USDT for SHIB), display_symbol is
-- the base plus USD, kucoin_symbol is BASE-USDT, sort_order continues from 20.
--
-- Options stays off for SHIB and PEPE: their tick is 1e-8, so the bid, ask and mid
-- barely move and about 35 to 41 percent of 30 s windows end with an identical
-- price (1 s klines, 2026-10-30), which settles as a draw. Spot stays enabled.
--
-- Vision ticker/24hr costs weight 2 for 1 to 20 symbols and 40 above that, so
-- callers split the 40 symbols into calls of at most 20 (src/lib/market/vision.ts,
-- supabase/functions/price-ingest). price_snapshots rows appear on the first
-- ingest of each market; nothing else needs seeding.

insert into public.markets
  (id, base, quote, display_symbol, vision_symbol, kucoin_symbol, price_decimals, sort_order,
   qty_decimals, min_notional_cents, options_enabled)
values
  ('AVAX-USDT',   'AVAX',   'USDT', 'AVAXUSD',   'AVAXUSDT',   'AVAX-USDT',   3, 21, 2, 500, true),
  ('DOT-USDT',    'DOT',    'USDT', 'DOTUSD',    'DOTUSDT',    'DOT-USDT',    3, 22, 2, 500, true),
  ('LTC-USDT',    'LTC',    'USDT', 'LTCUSD',    'LTCUSDT',    'LTC-USDT',    2, 23, 3, 500, true),
  ('ATOM-USDT',   'ATOM',   'USDT', 'ATOMUSD',   'ATOMUSDT',   'ATOM-USDT',   3, 24, 2, 500, true),
  ('ARB-USDT',    'ARB',    'USDT', 'ARBUSD',    'ARBUSDT',    'ARB-USDT',    4, 25, 1, 500, true),
  ('INJ-USDT',    'INJ',    'USDT', 'INJUSD',    'INJUSDT',    'INJ-USDT',    3, 26, 2, 500, true),
  ('FIL-USDT',    'FIL',    'USDT', 'FILUSD',    'FILUSDT',    'FIL-USDT',    4, 27, 2, 500, true),
  ('ETC-USDT',    'ETC',    'USDT', 'ETCUSD',    'ETCUSDT',    'ETC-USDT',    2, 28, 2, 500, true),
  ('SHIB-USDT',   'SHIB',   'USDT', 'SHIBUSD',   'SHIBUSDT',   'SHIB-USDT',   8, 29, 0, 100, false),
  ('HBAR-USDT',   'HBAR',   'USDT', 'HBARUSD',   'HBARUSDT',   'HBAR-USDT',   5, 30, 0, 500, true),
  ('ICP-USDT',    'ICP',    'USDT', 'ICPUSD',    'ICPUSDT',    'ICP-USDT',    3, 31, 2, 500, true),
  ('XLM-USDT',    'XLM',    'USDT', 'XLMUSD',    'XLMUSDT',    'XLM-USDT',    4, 32, 0, 500, true),
  ('RENDER-USDT', 'RENDER', 'USDT', 'RENDERUSD', 'RENDERUSDT', 'RENDER-USDT', 3, 33, 2, 500, true),
  ('FET-USDT',    'FET',    'USDT', 'FETUSD',    'FETUSDT',    'FET-USDT',    4, 34, 1, 500, true),
  ('BCH-USDT',    'BCH',    'USDT', 'BCHUSD',    'BCHUSDT',    'BCH-USDT',    1, 35, 3, 500, true),
  ('OP-USDT',     'OP',     'USDT', 'OPUSD',     'OPUSDT',     'OP-USDT',     4, 36, 2, 500, true),
  ('APT-USDT',    'APT',    'USDT', 'APTUSD',    'APTUSDT',    'APT-USDT',    4, 37, 2, 500, true),
  ('SEI-USDT',    'SEI',    'USDT', 'SEIUSD',    'SEIUSDT',    'SEI-USDT',    5, 38, 1, 500, true),
  ('TIA-USDT',    'TIA',    'USDT', 'TIAUSD',    'TIAUSDT',    'TIA-USDT',    4, 39, 2, 500, true),
  ('ONDO-USDT',   'ONDO',   'USDT', 'ONDOUSD',   'ONDOUSDT',   'ONDO-USDT',   4, 40, 1, 500, true);

-- Options on every market except SHIB and PEPE (it was BTC, ETH and SOL).
update public.markets set options_enabled = true
 where not options_enabled and id not in ('SHIB-USDT', 'PEPE-USDT');

-- Refuse to commit anything but the intended end state.
do $$
begin
  if (select count(*) from public.markets where enabled) <> 40
     or (select count(*) from public.markets where enabled and options_enabled) <> 38
     or exists (select 1 from public.markets where id in ('SHIB-USDT', 'PEPE-USDT') and options_enabled) then
    raise exception 'markets_40: expected 40 enabled markets, 38 with options_enabled (not SHIB or PEPE)';
  end if;
end $$;
