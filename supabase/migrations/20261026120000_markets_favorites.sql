-- Slice 3: market list and favourites (display data only; no money path reads these).
--
-- markets: the tradable pairs the UI lists. Public read of enabled rows,
-- no browser writes (rows are managed by migrations / the service role).
-- user_favorites: a user's starred markets, own rows only.

create table public.markets (
  id             text primary key check (id ~ '^[A-Z0-9]{2,12}-[A-Z0-9]{2,12}$'), -- 'BTC-USDT'
  base           text not null check (base ~ '^[A-Z0-9]{2,12}$'),
  quote          text not null check (quote ~ '^[A-Z0-9]{2,12}$'),
  display_symbol text not null,                                  -- 'BTCUSD', shown in the UI
  vision_symbol  text not null,                                  -- 'BTCUSDT'
  kucoin_symbol  text not null,                                  -- 'BTC-USDT'
  price_decimals integer not null check (price_decimals between 0 and 12),
  sort_order     integer not null default 0,
  enabled        boolean not null default true,
  check (id = base || '-' || quote)
);

create table public.user_favorites (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  market_id  text not null references public.markets (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, market_id)
);

alter table public.markets        enable row level security;
alter table public.user_favorites enable row level security;

create policy markets_select_enabled on public.markets for select to anon, authenticated
  using (enabled);

create policy user_favorites_select on public.user_favorites for select to authenticated
  using (user_id = (select auth.uid()));
create policy user_favorites_insert on public.user_favorites for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy user_favorites_delete on public.user_favorites for delete to authenticated
  using (user_id = (select auth.uid()));

-- Default privileges on public tables were revoked in slice 1; grant explicitly.
grant select on public.markets to anon, authenticated;
grant select, insert, delete on public.user_favorites to authenticated;

-- Top 20 USDT pairs that trade on both Vision and KuCoin, ranked by Vision 24h
-- quote volume on 2026-10-26 (stablecoins and leveraged tokens excluded; XMR
-- excluded because Vision serves a stale delisted book for it).
-- price_decimals = decimals of the Vision tick size. Keep at most 20 enabled
-- rows: Vision's ticker/24hr costs weight 2 for 1-20 symbols and 40 above that.
insert into public.markets (id, base, quote, display_symbol, vision_symbol, kucoin_symbol, price_decimals, sort_order) values
  ('BTC-USDT',  'BTC',  'USDT', 'BTCUSD',  'BTCUSDT',  'BTC-USDT',  2,  1),
  ('ETH-USDT',  'ETH',  'USDT', 'ETHUSD',  'ETHUSDT',  'ETH-USDT',  2,  2),
  ('ZEC-USDT',  'ZEC',  'USDT', 'ZECUSD',  'ZECUSDT',  'ZEC-USDT',  2,  3),
  ('SOL-USDT',  'SOL',  'USDT', 'SOLUSD',  'SOLUSDT',  'SOL-USDT',  2,  4),
  ('XRP-USDT',  'XRP',  'USDT', 'XRPUSD',  'XRPUSDT',  'XRP-USDT',  4,  5),
  ('NEAR-USDT', 'NEAR', 'USDT', 'NEARUSD', 'NEARUSDT', 'NEAR-USDT', 3,  6),
  ('BNB-USDT',  'BNB',  'USDT', 'BNBUSD',  'BNBUSDT',  'BNB-USDT',  2,  7),
  ('ENA-USDT',  'ENA',  'USDT', 'ENAUSD',  'ENAUSDT',  'ENA-USDT',  4,  8),
  ('WLD-USDT',  'WLD',  'USDT', 'WLDUSD',  'WLDUSDT',  'WLD-USDT',  4,  9),
  ('SUI-USDT',  'SUI',  'USDT', 'SUIUSD',  'SUIUSDT',  'SUI-USDT',  4, 10),
  ('PEPE-USDT', 'PEPE', 'USDT', 'PEPEUSD', 'PEPEUSDT', 'PEPE-USDT', 8, 11),
  ('UNI-USDT',  'UNI',  'USDT', 'UNIUSD',  'UNIUSDT',  'UNI-USDT',  3, 12),
  ('DOGE-USDT', 'DOGE', 'USDT', 'DOGEUSD', 'DOGEUSDT', 'DOGE-USDT', 5, 13),
  ('TRX-USDT',  'TRX',  'USDT', 'TRXUSD',  'TRXUSDT',  'TRX-USDT',  4, 14),
  ('QNT-USDT',  'QNT',  'USDT', 'QNTUSD',  'QNTUSDT',  'QNT-USDT',  2, 15),
  ('HYPE-USDT', 'HYPE', 'USDT', 'HYPEUSD', 'HYPEUSDT', 'HYPE-USDT', 2, 16),
  ('LINK-USDT', 'LINK', 'USDT', 'LINKUSD', 'LINKUSDT', 'LINK-USDT', 3, 17),
  ('TAO-USDT',  'TAO',  'USDT', 'TAOUSD',  'TAOUSDT',  'TAO-USDT',  1, 18),
  ('ADA-USDT',  'ADA',  'USDT', 'ADAUSD',  'ADAUSDT',  'ADA-USDT',  4, 19),
  ('AAVE-USDT', 'AAVE', 'USDT', 'AAVEUSD', 'AAVEUSDT', 'AAVE-USDT', 2, 20);
