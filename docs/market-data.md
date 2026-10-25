# AureonX — Market Data Plan (planning phase)

> **Merged 2026-10-25.** Where this doc conflicts with `docs/decisions.md`, `docs/decisions.md` wins. Table, column and RPC names follow `docs/data-model.md`.

> Status: **planning only**. Nothing here is implemented. AureonX is a **simulated** trading platform (demo funds, no real money).
> "Money path" below means any code that changes simulated balances, positions, fills, margin, liquidation, or options settlement.
> Provider names appear here only as data sources. **UI copy must never show provider names or branding** (use labels like "Live", "Delayed", "Indicative", "Daily reference rate").

---

## 0. TL;DR

| Data type | Crypto (BTC/USDT, ETH/USDT, …) | Forex + metals (XAU/USD, EUR/USD, AUD/*, CAD/JPY) |
|---|---|---|
| **Tickers** | Browser-direct REST from **one leader tab** per browser, 5 s; provider fallback chain | One **shared, edge-cached Worker route** (Workers Cache), 60 s client poll |
| **Klines** | Browser-direct REST on mount + on interval close; live candle patched from ticker | Shared Worker route; **no free official intraday source** → open decision |
| **Depth** | Browser-direct REST, 2 s, **only for the visible terminal's symbol** | **No free forex depth exists** → display-only synthetic/indicative book is an open decision |
| **Settlement price** | Server-side (Supabase Edge Function in a pinned non-US region): **median of ≥2 fresh exchange prices** (<60 s) | **XAU only via tokenized-gold proxy** (PAXG/XAUT on exchanges); **FX and XAG options not viable in v1** with free data |

The Worker route gets about **84 k requests a month** for 10 users at 4 h/day. Crypto polling never reaches the Worker. Section 7 shows the math.

**Big caveat:** every live probe from this sandbox was **blocked by the sandbox egress proxy** (56/56 calls, HTTP CONNECT 403). That means no upstream status, latency, CORS or rate-limit header was measured. One FX/metals source was measured for real, through its npm mirror. Everything else comes from primary docs fetched from GitHub, or from web research, and is labelled that way. **Run the probe script (§1.4) from a dev machine and from a deployed diagnostic Worker before implementation.**

**Correction to the brief:** Cloudflare Cache Rules sit *behind* a Worker, not in front of it. They cannot stop a Worker from being invoked. Cloudflare has a newer feature, **Workers Cache**, that does sit in front. It serves hits without running the Worker, but **each hit is still billed as a Worker request** (no CPU time). Details and citations are in §5.

---

## 1. Measurements

### 1.1 Environment

| Item | Value |
|---|---|
| Measurement window | 2026-10-25 07:35–07:50 UTC |
| Tool | `curl 8.5.0` via sandbox HTTPS proxy (`/root/.ccr/ca-bundle.crt`, TLS verification on) |
| Egress region | **Unknown.** The geo-IP echo endpoints (`ipinfo.io`, `ifconfig.co`, `ipapi.co`, `www.cloudflare.com/cdn-cgi/trace`, `1.1.1.1/cdn-cgi/trace`) were all **blocked by sandbox proxy**. |
| Proxy verdict text | `HTTP/1.1 403 Forbidden … request blocked: no rule or allowlist entry allows host "api.binance.com"` (the same for every market-data host) |
| Secondary fetcher | The `WebFetch` tool was also unable to reach these hosts (`getaddrinfo ENOTFOUND`) |
| Reachable from sandbox | `registry.npmjs.org`, `raw.githubusercontent.com`, `api.github.com` (used for the npm-mirror measurement and for primary docs) |

> To unblock this, add the hosts in §1.4 under **Allowed domains** in the cloud environment's Network access settings ([docs](https://code.claude.com/docs/en/cloud-environments#network-access)). Then re-run the probe.
> Even after unblocking, sandbox results ≠ Cloudflare PoP results ≠ end-user browser results. Geo-blocking depends on the caller's IP (§4).

### 1.2 Raw results — exchanges and FX/metals endpoints (GET + OPTIONS preflight, `Origin: https://aureonx.example`)

Every row below is the same result. The proxy rejected the request, so no upstream response, CORS header, rate-limit header or cache header could be observed. "Proxy RTT" is only the time the local proxy took to refuse. It is **not** upstream latency.

| UTC | Provider | Endpoint (data type) | GET | OPTIONS | Proxy RTT (s) | Bytes | CORS / RL / cache headers |
|---|---|---|---|---|---|---|---|
| 07:43:34 | Binance `api.binance.com` | `/api/v3/ticker/24hr?symbols=[…]` (tickers) | blocked by sandbox proxy | blocked | 0.210 | 0 | n/a |
| 07:43:35 | Binance | `/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=100` | blocked by sandbox proxy | blocked | 0.208 | 0 | n/a |
| 07:43:36 | Binance | `/api/v3/depth?symbol=BTCUSDT&limit=50` | blocked by sandbox proxy | blocked | 0.263 | 0 | n/a |
| 07:43:36 | Binance `data-api.binance.vision` | tickers / klines / depth (same paths) | blocked by sandbox proxy | blocked | 0.207–0.256 | 0 | n/a |
| 07:43:38 | KuCoin `api.kucoin.com` | `/api/v1/market/allTickers`, `/market/candles?type=1min`, `/market/orderbook/level2_20` | blocked by sandbox proxy | blocked | 0.209–0.394 | 0 | n/a |
| 07:43:39 | OKX `www.okx.com` | `/api/v5/market/tickers?instType=SPOT`, `/market/candles?bar=1m`, `/market/books?sz=50` | blocked by sandbox proxy | blocked | 0.250–0.263 | 0 | n/a |
| 07:43:41 | Bybit `api.bybit.com` | `/v5/market/tickers?category=spot`, `/kline?interval=1`, `/orderbook?limit=50` | blocked by sandbox proxy | blocked | 0.134–0.262 | 0 | n/a |
| 07:43:43 | Frankfurter `.dev` / `.app` | `/v1/latest`, `/latest` | blocked by sandbox proxy | blocked | 0.218 / 0.288 | 0 | n/a |
| 07:43:44 | gold-api | `/price/XAU`, `/price/XAG` | blocked by sandbox proxy | blocked | 0.247 / 0.249 | 0 | n/a |
| 07:43:45 | metals.live | `/v1/spot` | blocked by sandbox proxy | blocked | 0.239 | 0 | n/a |
| 07:43:45 | exchangerate.host | `/latest?symbols=XAU,XAG` | blocked by sandbox proxy | blocked | 0.260 | 0 | n/a |
| 07:43:46 | currency-api (jsDelivr / pages.dev) | `/v1/currencies/xau.json` | blocked by sandbox proxy | blocked | 0.264 / 0.275 | 0 | n/a |
| 07:43:47 | open.er-api | `/v6/latest/USD` | blocked by sandbox proxy | blocked | 0.161 | 0 | n/a |
| 07:43:48 | Yahoo chart | `/v8/finance/chart/EURUSD=X?interval=1m`, `GC=F` | blocked by sandbox proxy | blocked | 0.304 / 0.158 | 0 | n/a |
| 07:43:49 | TwelveData | `/price?symbol=XAU/USD` | blocked by sandbox proxy | blocked | 0.267 | 0 | n/a |
| 07:43:49 | Stooq | `/q/l/?s=xauusd&e=csv` | blocked by sandbox proxy | blocked | 0.274 | 0 | n/a |

The full TSV (56 rows) came from the script in §1.4.

### 1.3 Real measurement: currency-api (fawazahmed0) via its npm mirror

This dataset is published daily as the npm package `@fawazahmed0/currency-api`. jsDelivr serves files from that package, so the npm tarball holds the same files the CDN URL returns ([README](https://github.com/fawazahmed0/exchange-api)). This was the only market-data payload the sandbox could fetch.

| Item | Measured |
|---|---|
| Metadata fetch `registry.npmjs.org/@fawazahmed0%2fcurrency-api` | HTTP 200, 0.286 s, 626,899 B |
| Tarball `currency-api-2026.10.25.tgz` | HTTP 200, 0.206 s, 1,330,434 B (688 files) |
| Latest version / publish time | `2026.10.25`, registry `modified` = **2026-10-25T04:09:10Z**; one version per day (968 versions since 2024-03-02) |
| Payload freshness field | `"date": "2026-10-25"` (date only, no intraday timestamp) |
| API key | None |
| XAU/USD | **3993.6166** (`xau.json → xau.usd`) |
| XAG/USD | **53.8975** |
| EUR/USD | 1.12023759 |
| AUD/USD · AUD/JPY · AUD/CAD | 0.703386 · 110.31894995 · 0.98500358 |
| CAD/JPY · USD/JPY | 111.99852733 · 156.83984335 |
| Tokenized gold in XAU | PAXG = 0.9985134 XAU, XAUT = 1.00056753 XAU (about −15 bp / +6 bp basis vs. the XAU reference on that day) |

Conclusions: currency-api **does cover XAU and XAG**, with no key and no stated rate limits. It is **daily**, which is fine for a reference display and **not usable** for fresh (<60 s) pricing. It also carries PAXG and XAUT, which gives a daily cross-check of the tokenized-gold basis.

### 1.4 Probe script (re-run outside the sandbox)

Run it from (a) a dev laptop, noting your country, and (b) a temporary diagnostic Worker or Supabase Edge Function in each candidate region. Also record `cf-ray` / `cf-placement` or `x-sb-edge-region`.

```bash
#!/usr/bin/env bash
# ./probe.sh > results.tsv   — records status, latency, bytes, CORS, rate-limit and cache headers
ORIGIN="https://aureonx.example"
URLS=(
 "binance tickers https://api.binance.com/api/v3/ticker/24hr?symbols=%5B%22BTCUSDT%22,%22ETHUSDT%22,%22PAXGUSDT%22%5D"
 "binance klines  https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=100"
 "binance depth   https://api.binance.com/api/v3/depth?symbol=BTCUSDT&limit=50"
 "binvision tickers https://data-api.binance.vision/api/v3/ticker/24hr?symbols=%5B%22BTCUSDT%22,%22ETHUSDT%22,%22PAXGUSDT%22%5D"
 "binvision klines  https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=100"
 "binvision depth   https://data-api.binance.vision/api/v3/depth?symbol=BTCUSDT&limit=50"
 "kucoin tickers https://api.kucoin.com/api/v1/market/allTickers"
 "kucoin klines  https://api.kucoin.com/api/v1/market/candles?symbol=BTC-USDT&type=1min"
 "kucoin depth   https://api.kucoin.com/api/v1/market/orderbook/level2_20?symbol=BTC-USDT"
 "okx tickers https://www.okx.com/api/v5/market/tickers?instType=SPOT"
 "okx klines  https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=1m&limit=100"
 "okx depth   https://www.okx.com/api/v5/market/books?instId=BTC-USDT&sz=50"
 "bybit tickers https://api.bybit.com/v5/market/tickers?category=spot"
 "bybit klines  https://api.bybit.com/v5/market/kline?category=spot&symbol=BTCUSDT&interval=1&limit=100"
 "bybit depth   https://api.bybit.com/v5/market/orderbook?category=spot&symbol=BTCUSDT&limit=50"
 "frankfurter.dev tickers https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR,AUD,JPY,CAD"
 "frankfurter.app tickers https://api.frankfurter.app/latest?from=USD&to=EUR,AUD,JPY,CAD"
 "gold-api XAU https://api.gold-api.com/price/XAU"
 "gold-api XAG https://api.gold-api.com/price/XAG"
 "metals.live spot https://api.metals.live/v1/spot"
 "exchangerate.host latest https://api.exchangerate.host/latest?base=USD&symbols=XAU,XAG"
 "currency-api jsdelivr https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/xau.json"
 "currency-api pages https://latest.currency-api.pages.dev/v1/currencies/xau.json"
 "open.er-api latest https://open.er-api.com/v6/latest/USD"
 "yahoo EURUSD_1m https://query1.finance.yahoo.com/v8/finance/chart/EURUSD=X?interval=1m&range=1d"
 "yahoo GC=F_1m https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=1m&range=1d"
 "twelvedata XAU/USD https://api.twelvedata.com/price?symbol=XAU/USD&apikey=demo"
 "stooq xauusd https://stooq.com/q/l/?s=xauusd&f=sd2t2ohlcv&h&e=csv"
)
printf "utc\tprovider\tkind\tmethod\thttp\ttime_s\tbytes\tacao\tacam\theaders\n"
for row in "${URLS[@]}"; do
  read -r prov kind url <<<"$row"
  for method in GET OPTIONS; do
    H=$(mktemp)
    extra=(); [ $method = OPTIONS ] && extra=(-X OPTIONS -H "Access-Control-Request-Method: GET")
    out=$(curl -sS -m 20 -o /dev/null -D "$H" -H "Origin: $ORIGIN" "${extra[@]}" \
          -w '%{http_code}\t%{time_total}\t%{size_download}' "$url" 2>&1 | tail -1)
    acao=$(grep -i '^access-control-allow-origin' "$H" | tail -1 | cut -d' ' -f2- | tr -d '\r')
    acam=$(grep -i '^access-control-allow-methods' "$H" | tail -1 | cut -d' ' -f2- | tr -d '\r')
    hdr=$(grep -i -E '^(x-mbx-used-weight[^:]*|x-ratelimit[^:]*|ratelimit[^:]*|x-bapi-limit[^:]*|retry-after|cache-control|age|cf-cache-status|x-cache|expires|etag|last-modified):' "$H" | tr -d '\r' | paste -sd';' -)
    printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" "$(date -u +%FT%TZ)" "$prov" "$kind" "$method" "$out" "${acao:--}" "${acam:--}" "${hdr:--}"
    rm -f "$H"
  done
done
```

**Acceptance gate before implementation:** for each crypto provider, from at least one EU and one US vantage point, record: GET status, `Access-Control-Allow-Origin` on GET **and** OPTIONS, `x-mbx-used-weight-1m` / `x-bapi-limit*` / other rate-limit headers, `Cache-Control`, and the payload timestamp lag.

### 1.5 What we know from primary docs (not measured here)

| Provider | Tickers | Klines | Depth | Rate limit (IP) | RL headers | Source |
|---|---|---|---|---|---|---|
| Binance (`api.binance.com`, `data-api.binance.vision`) | `/api/v3/ticker/24hr?symbols=[..]` weight 2 for 1–20 symbols, 40 for 21–100, max 100 symbols | `/api/v3/klines` weight 2, limit ≤1000 (default 500), **oldest→newest**, intervals `1s 1m 3m 5m 15m 30m 1h 2h 4h 6h 8h 12h 1d 3d 1w 1M` | `/api/v3/depth` weight 5 (limit ≤100), 25 (≤500), 50 (≤1000), 250 (≤5000) | `REQUEST_WEIGHT` 6000/min; 429 → back off; repeat → **418 IP ban**; `Retry-After` header | `X-MBX-USED-WEIGHT-1M` | [rest-api.md](https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md), [market_data_only.md](https://github.com/binance/binance-spot-api-docs/blob/master/faqs/market_data_only.md) |
| Bybit v5 | `/v5/market/tickers?category=spot` (all, or `symbol=`) | `/v5/market/kline` limit 1–1000 (default 200), intervals `1 3 5 15 30 60 120 240 360 720 D W M`, **newest→oldest** | `/v5/market/orderbook?category=spot` limit 1–200 | **600 req / 5 s per IP**, shared by `api.bybit.com` + `api.bytick.com`; violation → **HTTP 403, ~30 min ban** | `X-Bapi-Limit`, `X-Bapi-Limit-Status`, `X-Bapi-Limit-Reset-Timestamp` | [rate-limit.mdx](https://github.com/bybit-exchange/docs/blob/main/docs/v5/rate-limit.mdx), [kline.mdx](https://github.com/bybit-exchange/docs/blob/main/docs/v5/market/kline.mdx), [orderbook.mdx](https://github.com/bybit-exchange/docs/blob/main/docs/v5/market/orderbook.mdx), [guide.mdx](https://github.com/bybit-exchange/docs/blob/main/docs/v5/guide.mdx) |
| OKX v5 | `/api/v5/market/tickers?instType=SPOT` (all), `/market/ticker?instId=` | `/market/candles` limit ≤300, **newest→oldest**; daily+ bars default to UTC+8 unless suffixed `utc` (`1Dutc`) | `/market/books?sz=` | Per-endpoint per-IP (ccxt weights: tickers 1, candles/books ½); official numbers to be re-verified | (to measure) | [ccxt okx.ts](https://github.com/ccxt/ccxt/blob/master/ts/src/okx.ts) (secondary; official docs host blocked) |
| KuCoin | `/api/v1/market/allTickers` (ccxt cost 15) | `/api/v1/market/candles?type=1min` limit ≤1500, **newest→oldest**, row = `[t(sec), open, close, high, low, vol, turnover]` (**note the O-C-H-L order**) | `/market/orderbook/level2_20` / `level2_100` (public) | Weight pool per IP (to re-verify) | (to measure) | [ccxt kucoin.ts](https://github.com/ccxt/ccxt/blob/master/ts/src/kucoin.ts) (secondary) |
| Frankfurter | Daily central-bank reference rates (ECB-based default blend, 200+ currencies, 100+ sources), `/v1/latest`, `/v2/*` | Daily time series only (one fix per day, no OHLC) | none | Not documented as strict | — | [frankfurter README](https://github.com/lineofflight/frankfurter) |
| currency-api | Daily, includes XAU/XAG/PAXG/XAUT (measured §1.3) | Daily snapshots by date URL | none | "No rate limits" | — | [exchange-api README](https://github.com/fawazahmed0/exchange-api) |
| TwelveData (free "Basic") | Needs an **API key**; 8 credits/min, **800/day** cap, resets 00:00 UTC; forex/crypto listed; XAU/USD coverage on free plan unverified | `time_series` 1min…1month | none | 800/day | — | [pricing](https://twelvedata.com/pricing), [credits](https://support.twelvedata.com/en/articles/5615854-credits) |
| gold-api.com, metals.live, exchangerate.host, open.er-api, Yahoo chart, Stooq | **Unverified this session** (hosts blocked, search found no primary docs). Yahoo chart is an **unofficial** endpoint (no SLA/ToS for API use). exchangerate.host now requires a key (to verify). | | | | | — |

**CORS: unknown for all providers.** Web research turned up only conflicting anecdotes. CORS is the gating fact for browser-direct (§1.4 acceptance gate). The plan below includes the fallback for any provider without `Access-Control-Allow-Origin: *`.

---

## 2. Coverage matrix (needed pairs)

| Pair | Free real-time (<60 s) source | Free daily source | Notes |
|---|---|---|---|
| BTC/USDT, ETH/USDT, other crypto spot | Binance, OKX, Bybit, KuCoin REST (all have tickers, klines, depth) | — | Region-dependent (§4) |
| **XAU/USD** | **PAXG/USDT, XAUT/USDT on exchanges** (24/7 proxy; 1 token ≈ 1 troy oz; basis ±0.1–0.2% observed §1.3). gold-api (claimed real-time, unverified). TwelveData (key, 800/day) | currency-api (measured), Frankfurter (XAU not expected, verify `/v2/currencies`) | Tokenized gold ≠ spot XAU; label "Indicative" |
| **XAG/USD** | None reliable for free (gold-api claimed, unverified; no liquid tokenized silver on the four exchanges, to verify) | currency-api (measured) | |
| EUR/USD, AUD/USD, AUD/JPY, AUD/CAD, CAD/JPY | None official for free. Yahoo `EURUSD=X` (unofficial). TwelveData (key, 800/day cap = ~1 refresh / 14 min for 8 pairs) | Frankfurter, currency-api (measured, all pairs directly or via cross) | Crosses: compute from USD legs with decimal math, or read `aud.json` directly |
| Forex klines (intraday) | Yahoo chart 1m/5m/15m/30m/60m (unofficial). TwelveData (key, budget-limited) | Frankfurter daily series (close-only) | No free *official* intraday candles |
| Forex depth | **None** | — | Forex is OTC; no public free L2. See Open decision D2 |

---

## 3. Recommendations per data type

### 3.1 Architecture overview

```
Browser (per user)
 ├─ Tab A (leader: holds Web Lock "aureonx-md")  ──REST──►  exchange public APIs (crypto tickers/klines/depth)
 │     │                                         └─GET───►  md Worker route /md/v1/* (FX + metals; Workers Cache in front)
 │     └─ BroadcastChannel("aureonx-md")  ──snapshots──►  Tab B, Tab C (followers; never fetch)
 │
Cloudflare: "aureonx-md" Worker (separate from the OpenNext app Worker)
 ├─ cache.enabled = true  (Workers Cache: tiered + request collapsing; hits don't run the Worker)
 ├─ placement.region = "aws:eu-central-1" (Placement Hint → upstream fetches from a non-US PoP on misses)
 └─ fetch(): upstream FX/metals; returns normalized JSON + Cache-Control: public, max-age=N, stale-while-revalidate=M

Supabase (settlement; owned by the settlement agent)
 └─ Edge Function "price-ingest" (data-model.md §7) invoked with x-region: eu-central-1 (pg_cron, 10 s, demand-gated) → ≥2 exchanges → median → ingest_prices
```

### 3.2 Tickers

* **Crypto: browser-direct**, from the leader tab only, every **5 s** while any AureonX tab is visible.
  * One batched call per provider per cycle. Binance: `ticker/24hr?symbols=[…]` with ≤20 symbols costs weight 2; bigger lists are split into chunks of 20 or sent as a single all-symbol call to Bybit/OKX/KuCoin.
  * Rate limits are per **user IP**, so per-user browser polling spreads load naturally and never touches our Worker.
  * If a provider lacks CORS, or is geo-blocked for this user (451 / geo-403), the leader moves to the next provider in the fallback chain (§6.4). If **every** crypto provider fails for the user's region, the client switches to the md Worker's crypto route (`/md/v1/crypto/tickers`). That route is cached at max-age=5 and placed via Placement Hint in a region the exchanges serve. This is the *only* case where crypto traffic reaches the Worker, and it is still one shared cached URL.
* **Forex/metals: shared Worker route** `GET /md/v1/fx/tickers?set=core`. Use one fixed URL per symbol set so every client shares the same cache key and the query string is never user-built. Client polls every **60 s**.
  * Upstream (decided by Open decision D1): daily reference (Frankfurter → currency-api fallback), plus XAU/XAG from the chosen near-real-time source, plus PAXG/XAUT mid from the crypto providers as an XAU proxy.
  * Response header `Cache-Control: public, max-age=30, stale-while-revalidate=30`. For a daily-only set, use `max-age=900, stale-while-revalidate=3600`.
* **Never** feed browser-fetched prices into a money path. The server re-fetches its own prices.

### 3.3 Klines

* **Crypto: browser-direct.**
  * On terminal mount or symbol/interval change: one fetch with limit 500 (Binance) or 300 (OKX), normalized to oldest→newest.
  * At each interval close + 1–2 s jitter: re-fetch only the last 2 candles (`limit=2`).
  * Between closes, the **live candle is patched from the ticker stream** (display-only: update close/high/low). This avoids per-second kline polling.
  * For ≥1h intervals, re-fetch the last 2 candles every 60 s.
* **Forex: shared Worker route** `GET /md/v1/fx/klines?symbol=EUR-USD&interval=1h`, `max-age = min(interval, 300)`. Source is Open decision D3. If no intraday source is approved, show daily close-only candles labelled "Daily reference" and disable sub-daily intervals for forex in v1.

### 3.4 Depth

* **Crypto: browser-direct**, every **2 s**, and **only** for the symbol in a visible terminal. Limit 20 (Binance weight 5).
  * With no visible terminal: no depth polling.
  * Hidden document: pause.
  * The best bid/ask from depth also refreshes the terminal header price between ticker polls.
* **Forex: no free depth source exists** (OTC market). This is Open decision D2. Whatever is chosen must be **display-only** and labelled "Indicative". It must never be used for fills, slippage or margin.

### 3.5 Settlement price (input to the settlement agent's design)

* **Server-side only.** Merged with the data model: there is one Edge Function, `price-ingest` (`docs/data-model.md` §7), run every 10 s by pg_cron while there is demand. The validation rules below run inside it before it calls `ingest_prices`; the database then applies its own freshness checks (≤15 s for entry and fills, at-or-after expiry and ≤60 s for settlement). It is invoked from pg_cron with `x-region` / `forceFunctionRegion` pinned to a region the exchanges serve (EU first; measure). Region pinning is documented in [Supabase regional invocation](https://supabase.com/docs/guides/functions/regional-invocation). Without pinning, a function runs nearest the caller. Verify via the `x-sb-edge-region` response header.
* **Crypto options:**
  * Price = **median** of the mid (or last) from ≥2 of {Binance `data-api.binance.vision`, OKX, Bybit, KuCoin}.
  * Each source must have an exchange timestamp ≤ **30 s** old and a fetch ≤ **10 s** ago.
  * Sources must agree within ≤ **50 bp** of the median (threshold = Open decision D4).
  * Fewer than 2 qualifying sources → status `UNAVAILABLE` → retry with backoff until expiry + grace. The settlement agent defines the policy after that (e.g. void or postpone). **Never** settle on a stale or single unchecked price.
* **XAU options:** only via the **tokenized-gold proxy**: median of PAXG/USDT and XAUT/USDT across exchanges, converted with USDT≈USD (or divided by USDC/USDT if available). This is fresh (24/7) but is a *proxy*: the basis to spot is about −0.15%/+0.06% on 2026-10-25 (§1.3). Product copy must say "settles to the indicative gold reference" and never name the token or exchange.
* **FX options (EUR/USD, AUD/*, CAD/JPY) and XAG options: not viable in v1** with free data. The free official sources are daily. The only free intraday option is an unofficial endpoint (Yahoo chart). The keyed free tier (TwelveData) has 800 calls/day, about one refresh every 14 min for 8 pairs, which fails the <60 s requirement. Recommendation: defer, or settle FX options **daily** at the reference-rate fix (Open decision D5).

---

## 4. Regional restrictions (API level)

| Provider | What is known | Evidence quality |
|---|---|---|
| **Binance** `api.binance.com` | Returns **HTTP 451 "Service unavailable from a restricted location"** to US IPs, and reportedly to some cloud/datacenter ranges (a US Linode got 451, Frankfurt did not; Railway reports US/NL/SG ranges affected). Restrictions on public market data date from late 2022. | Community reports: [Linode](https://www.linode.com/community/questions/23972/linode-and-binancecom), [Vercel](https://community.vercel.com/t/binance-api-calls-on-vercel/29895), [Railway](https://station.railway.com/questions/deployment-is-crashing-7b190d57), [CryptoDataDownload](https://www.cryptodatadownload.com/blog/posts/binance-download-data-python-usa-residents/) |
| Binance `data-api.binance.vision` | Official market-data-only host (no key); docs list no geo limits. Whether it 451s US IPs is **unverified**. Must measure. | [market_data_only.md](https://github.com/binance/binance-spot-api-docs/blob/master/faqs/market_data_only.md) |
| **Bybit** | The service agreement excludes the US, Canada, Singapore, Hong Kong and Mainland China, among others ([help center](https://bybit.com/en/help-center/article/Service-Restricted-Countries)). Cloud/US IPs reportedly get **HTTP 403 at the CDN edge** before auth ([QuotaGuard, vendor blog](https://quotaguard.com/blog/bybit-api-403-cloud-platform-cdn-block-fix)). Docs tell NL users to use `api.bybit.nl` and HK users `api.bybit.com.hk`; `api.bybit.com` "has the possibility to be shutdown at any time" for them ([guide.mdx](https://github.com/bybit-exchange/docs/blob/main/docs/v5/guide.mdx)). Note: Bybit's *rate-limit* ban is also a 403, so a 403 is ambiguous. Treat 403 with no JSON body as geo/edge-block and 403 after a burst as rate ban. | Official + vendor |
| **OKX** | Separate regional platforms: global `www.okx.com`, EEA `my.okx.com`, US `app.okx.com` / `us.okx.com` ([okx-api SDK regions](https://www.mintlify.com/tiagosiebler/okx-api/guides/regions), [ccxt OKX US](https://docs.ccxt.com/docs/comparisons/ccxt-vs-okxus-api)). Global service is restricted for US residents. API-level IP behavior for public endpoints is **unverified**. | Secondary |
| **KuCoin** | Announced on 2025-01-16 that **access from US IP addresses is restricted** effective 2025-01-23 ([announcement](https://kucoin.com/announcement/us-ip-access-restrictions-and-guidance-on-asset-withdrawals-for-users-in-the-united-states)). Whether public API endpoints are covered is **unverified**. | Official (web), API effect inferred |
| Frankfurter / currency-api | No geo restrictions documented. | Docs |

**Implications for our topology:**

* **Browser-direct:** the user's own IP decides. A US user will likely get 451/403 from all four crypto exchanges. That is the reason for the region-fallback route in §3.2. Whether US users are a target audience at all is a product and compliance question; see D6.
* **Cloudflare Workers** run in the PoP nearest the user by default, so a Worker hit by a US user that misses cache fetches upstream from a **US** PoP and may get 451. Mitigation: a **Placement Hint** `placement.region = "aws:eu-central-1"` (or `aws:ap-northeast-1`) on the md Worker. Its `fetch` handler then runs near that region on cache misses ([placement docs](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/workers/configuration/placement.mdx)). Workers Cache lower and upper tiers are consulted *before* placement, so hits stay local ([Workers Cache: Smart placement and the cache](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/workers/cache/index.mdx)). Cloudflare egress IPs can still be flagged as "datacenter" by exchanges, so this must be measured.
* **Supabase Edge Functions** run nearest the caller unless pinned via `x-region`. Pin the oracle to an EU region and measure from it.
* **Compliance note:** using placement or regions to *circumvent* an exchange's geo-restriction for users in restricted jurisdictions may violate that exchange's terms. AureonX only displays public reference data for a simulator and never trades on these exchanges, but legal should confirm. This is D6.

### Browser-direct websockets (alternative, not the default)

Binance `wss://data-stream.binance.vision/ws/<sym>@kline_1m`, Bybit `wss://stream.bybit.com/v5/public/spot`, OKX `wss://ws.okx.com:8443/ws/v5/public`. KuCoin requires a `POST /api/v1/bullet-public` token first, which needs CORS or a server.

* Pros: true real-time; no polling cost; no Worker involvement; CORS does not apply (WebSocket has no CORS, though servers may check `Origin`).
* Cons: same geo-blocks; reconnect, heartbeat and resubscribe logic for each provider; a hidden tab still holds sockets unless explicitly closed; harder to share across tabs (the leader must own the socket); and the previous build removed a websocket proxy, so the team's preference is REST.

Recommendation: **default to polling REST**. Consider leader-tab websockets for depth only in v2.

---

## 5. Cloudflare caching facts (verified against docs source)

1. **Cache Rules do not sit in front of a Worker.**
   * "Only requests that hit a Worker will count against your limits and your bill. **Since Cloudflare Workers runs before the Cloudflare cache, the caching of a request still incurs costs.**" ([pricing.mdx](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/workers/platform/pricing.mdx))
   * The zone cache, which Cache Rules configure, sits between the Worker's `fetch()` subrequests and the origin ([how-the-cache-works](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/workers/reference/how-the-cache-works.mdx)).
   * So Cache Rules on a custom domain **do not** produce zero-invocation hits for a Worker route. The fact that `workers.dev` lacks zone features like Cache Rules is moot.
2. **Workers Cache** (`"cache": { "enabled": true }` in wrangler config) runs *in front of* the Worker.
   * "Cloudflare checks the cache before running your Worker. On a hit, the cached response is returned directly." It is **tiered by default** with **request collapsing**, and it works on `workers.dev`, routes and custom domains alike (the cache key excludes the host).
   * Zone Cache Rules have **no effect** on it.
   * Source: [workers/cache/index.mdx](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/workers/cache/index.mdx), [limitations.mdx](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/workers/cache/limitations.mdx), [cache-keys.mdx](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/workers/cache/cache-keys.mdx).
3. **Workers Cache hits are billed as requests, not CPU.** "All requests to your Worker are billed at the standard Workers request rate… whether the response comes from cache or from your Worker… CPU time is only billed when your Worker runs."
   * Free plan: **100,000 requests/day**.
   * Paid: **10 M/month included, then $0.30/M**.
   * Enabling it also bills requests that are normally free (static assets, service-binding calls). That is a strong reason to **not** enable it on the OpenNext app Worker and to use a **separate md Worker**.
4. **The Cache API (`caches.default`) does not avoid invocation.** Every request still runs the Worker. It is per-data-center, has no tiering and no request collapsing.
5. **Header semantics:**
   * Use `max-age` with `stale-while-revalidate`. **Avoid `s-maxage`**: in Workers Cache, `s-maxage`, `must-revalidate` and `proxy-revalidate` disable both stale-while-revalidate and stale-if-error.
   * Without `s-maxage`, Cloudflare by default serves stale content on Worker error *indefinitely*. Set `stale-if-error=60` explicitly so outages surface. The client also judges staleness from the payload's `asOf` timestamps, never from HTTP freshness.
   * Responses with `Set-Cookie`, or requests with `Authorization`, bypass the cache. The md routes must be cookie-free and auth-free.
   * The cache key includes the Worker version (each deploy starts cold) and the exact query string (order matters). Use canonical fixed URLs.
6. **True "zero Worker request" options** for recurring data:
   * (a) browser-direct to upstream (our crypto default);
   * (b) static files: R2 public bucket on a custom domain, or Static Assets, written by a Cron Worker. The minimum cron interval is 1 min, so this only suits daily or minute-level FX;
   * (c) a non-Worker origin behind the zone cache.

   Workers Cache hits are *cheap* (no CPU) but not zero-request.

---

## 6. Provider interface (design — not a source file)

```ts
// ---------- Canonical identifiers ----------
export type AssetClass = 'crypto' | 'forex' | 'metal';
/** Canonical symbol: BASE/QUOTE, upper-case. e.g. "BTC/USDT", "EUR/USD", "XAU/USD", "AUD/JPY" */
export type CanonicalSymbol = `${string}/${string}`;
export type Interval = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1D' | '1W' | '1M';
export type ProviderId =
  | 'binance' | 'binanceVision' | 'okx' | 'bybit' | 'kucoin'          // crypto
  | 'fxDaily' | 'fxDailyAlt' | 'metalsLive' | 'tokenGold' | 'fxIntraday'; // FX/metals (concrete source per D1/D3)

/** Decimal values are ALWAYS strings (never JS numbers) to avoid float drift. Parse with a decimal lib. */
export type Dec = string;

export interface Quality {
  provider: ProviderId;
  /** Provider's own event/close timestamp (ms epoch, UTC). */
  sourceTs: number;
  /** When our fetcher received it (ms epoch). */
  fetchedAt: number;
  /** live: fresh real-time · delayed: past fresh threshold · reference: daily fix · indicative: proxy/synthetic */
  grade: 'live' | 'delayed' | 'reference' | 'indicative';
  stale: boolean;
}

export interface Ticker extends Quality {
  symbol: CanonicalSymbol;
  last: Dec;
  bid?: Dec; ask?: Dec;
  open24h?: Dec; high24h?: Dec; low24h?: Dec;
  change24hPct?: Dec;
  baseVolume24h?: Dec; quoteVolume24h?: Dec;
}

export interface Candle {
  openTime: number;   // ms epoch UTC, start of bucket
  open: Dec; high: Dec; low: Dec; close: Dec;
  volume: Dec;        // base volume ("0" for FX)
  closed: boolean;    // false for the in-progress candle
}
export interface KlineSeries extends Quality {
  symbol: CanonicalSymbol; interval: Interval;
  candles: Candle[];  // ALWAYS oldest → newest after normalization
}

export interface DepthLevel { price: Dec; qty: Dec }
export interface DepthSnapshot extends Quality {
  symbol: CanonicalSymbol;
  bids: DepthLevel[]; // best first (desc)
  asks: DepthLevel[]; // best first (asc)
  sequence?: string;  // lastUpdateId / seqId / u, as string
  synthetic?: true;   // forex indicative book (D2) — MUST be rejected by any money path
}

export interface MarketDataProvider {
  id: ProviderId;
  assetClasses: AssetClass[];
  supports(symbol: CanonicalSymbol): boolean;
  getTickers(symbols: CanonicalSymbol[], opts?: { signal?: AbortSignal }): Promise<Ticker[]>;
  getKlines(symbol: CanonicalSymbol, interval: Interval, limit: number,
            opts?: { signal?: AbortSignal; endTime?: number }): Promise<KlineSeries>;
  getDepth(symbol: CanonicalSymbol, limit: number, opts?: { signal?: AbortSignal }): Promise<DepthSnapshot>;
}

/** Errors are classified so the router can decide: next provider vs. cooldown vs. give up. */
export type ProviderErrorKind =
  | 'geo_blocked'      // 451, or 403 without a rate-limit context (Bybit edge)
  | 'rate_limited'     // 429, Bybit 403-after-burst, 'Too many visits!'
  | 'banned'           // 418 (Binance) — obey Retry-After
  | 'cors'             // TypeError on fetch with no response (browser)
  | 'timeout' | 'upstream_5xx' | 'bad_payload' | 'unsupported_symbol';
export class ProviderError extends Error {
  constructor(public kind: ProviderErrorKind, public provider: ProviderId,
              public retryAfterMs?: number) { super(`${provider}:${kind}`); }
}

/** Router: composes providers with fallback, staleness, retries and negative cache. */
export interface MarketDataRouter {
  getTickers(symbols: CanonicalSymbol[]): Promise<Ticker[]>;
  getKlines(symbol: CanonicalSymbol, interval: Interval, limit: number): Promise<KlineSeries>;
  getDepth(symbol: CanonicalSymbol, limit: number): Promise<DepthSnapshot>;
}

/** Server-only contract consumed by the settlement agent (Supabase). */
export interface SettlementPrice {
  symbol: CanonicalSymbol;
  price: Dec | null;
  status: 'OK' | 'UNAVAILABLE';
  method: 'median_mid' | 'median_last' | 'token_gold_median';
  asOf: number;                          // max(sourceTs) of the used inputs
  inputs: Array<{ provider: ProviderId; value: Dec; sourceTs: number; used: boolean; reason?: string }>;
}
```

### 6.1 Symbol mapping

| Canonical | Binance / Vision | OKX | Bybit (`category=spot`) | KuCoin |
|---|---|---|---|---|
| BTC/USDT | `BTCUSDT` | `BTC-USDT` | `BTCUSDT` | `BTC-USDT` |
| ETH/USDT | `ETHUSDT` | `ETH-USDT` | `ETHUSDT` | `ETH-USDT` |
| PAXG/USDT (XAU proxy) | `PAXGUSDT` | `PAXG-USDT` | `PAXGUSDT` | `PAXG-USDT` |
| XAUT/USDT (XAU proxy) | `XAUTUSDT` (spot listing to verify) | `XAUT-USDT` | `XAUTUSDT` | `XAUT-USDT` |

Rule: `binance/bybit = base+quote`, `okx/kucoin = base-quote`. Listings are verified at startup against `exchangeInfo` / `instruments` (cached 24 h). A symbol not listed at a provider goes to the next provider (`unsupported_symbol`).

| Canonical | Frankfurter | currency-api | Yahoo chart (if D3 chooses it) | TwelveData (if keyed) |
|---|---|---|---|---|
| EUR/USD | `/v1/latest?base=EUR&symbols=USD` | `eur.json → .eur.usd` | `EURUSD=X` | `EUR/USD` |
| AUD/USD, AUD/JPY, AUD/CAD | `base=AUD&symbols=USD,JPY,CAD` | `aud.json → .aud.{usd,jpy,cad}` | `AUDUSD=X`, `AUDJPY=X`, `AUDCAD=X` | `AUD/USD` … |
| CAD/JPY | `base=CAD&symbols=JPY` | `cad.json → .cad.jpy` | `CADJPY=X` | `CAD/JPY` |
| XAU/USD | (not expected; verify) | `xau.json → .xau.usd` | `GC=F` is **futures**, not spot; avoid | `XAU/USD` |
| XAG/USD | (not expected) | `xag.json → .xag.usd` | `SI=F` futures; avoid | `XAG/USD` |

### 6.2 Interval mapping

| Ours | Binance | OKX `bar` | Bybit `interval` | KuCoin `type` | Yahoo `interval` | TwelveData |
|---|---|---|---|---|---|---|
| 1m | `1m` | `1m` | `1` | `1min` | `1m` | `1min` |
| 5m | `5m` | `5m` | `5` | `5min` | `5m` | `5min` |
| 15m | `15m` | `15m` | `15` | `15min` | `15m` | `15min` |
| 30m | `30m` | `30m` | `30` | `30min` | `30m` | `30min` |
| 1h | `1h` | `1H` | `60` | `1hour` | `60m` | `1h` |
| 4h | `4h` | `4H` | `240` | `4hour` | — (aggregate 4×60m) | `4h` |
| 1D | `1d` | **`1Dutc`** (plain `1D` is UTC+8) | `D` | `1day` | `1d` | `1day` |
| 1W | `1w` | **`1Wutc`** | `W` | `1week` | `1wk` | `1week` |
| 1M | `1M` | **`1Mutc`** | `M` | `1month` (verify; else aggregate from 1D) | `1mo` | `1month` |

Normalization:
* All providers' candles become **oldest→newest**. Binance is native; OKX, Bybit and KuCoin are reversed.
* KuCoin timestamps are **seconds** and its rows are **O, C, H, L**. Remap.
* OKX's last array field `confirm` gives the `closed` flag. Binance, Bybit and KuCoin do not; derive it from `openTime + interval <= serverNow`.
* Max `limit`: Binance 1000, OKX 300, Bybit 1000, KuCoin 1500. The router clamps.

### 6.3 Staleness rules

| Data | Fresh (`live`) | `delayed` badge | Switch provider | Money path |
|---|---|---|---|---|
| Crypto ticker | `now − sourceTs ≤ 15 s` | 15–60 s | > 60 s or 2 failed cycles | **never** uses client data; server needs ≤ 10 s (fills; data-model agent) / ≤ 30 s per input (settlement) |
| Crypto depth | ≤ 6 s (3 cycles) | grey out book > 6 s | > 15 s | never |
| Crypto klines | last closed candle ≤ 2 × interval old | badge | > 3 × interval | never |
| XAU/XAG near-real-time | ≤ 60 s | 60–300 s | > 300 s → fall back to `indicative` token-gold | XAU settlement via token-gold only (§3.5) |
| FX daily reference | n/a (grade `reference`; show "as of <date>") | date older than last business day + 1 | after 2 business days | not used in v1 |
| Synthetic FX book | always `indicative` | — | — | **rejected** (`synthetic: true`) |

UI copy, which the UI agent owns: "Live", "Delayed", "Indicative", "Daily reference rate · as of 24 Oct". No provider names.

### 6.4 Fallback order per asset class

* **Crypto (browser):** `binanceVision → okx → bybit → kucoin`, then the md Worker region-fallback route.
  * `binanceVision` comes first because it is the official market-data-only host with high limits. `api.binance.com` is used only if Vision fails *and* returns non-geo errors.
  * The provider that succeeded is remembered per browser (per-viewer localStorage convenience, wrapped in try/catch), with a 1 h TTL. `geo_blocked` and `cors` mark a provider *unusable for this session*.
  * The order is not final until the probe data from §1.4 is in.
* **Crypto (server / settlement):** query `binanceVision, okx, bybit, kucoin` **in parallel** and take the median of qualifying inputs (§3.5).
* **XAU:** near-real-time source (D1) → token-gold median (`PAXG/USDT`, `XAUT/USDT`) → currency-api daily (`reference`).
* **XAG:** near-real-time source (D1) → currency-api daily (`reference`).
* **FX:** intraday source (D3, if any) → Frankfurter `.dev` → Frankfurter `.app` → currency-api jsDelivr → currency-api `pages.dev` (the README recommends this fallback).

### 6.5 Retry, backoff, negative cache

| Parameter | Browser leader | md Worker | Supabase oracle |
|---|---|---|---|
| Per-request timeout | 4 s (tickers/depth), 8 s (klines) | 4 s | 5 s |
| Retries per cycle | 1 | 1 | 2 |
| Backoff | full jitter: `rand(0, min(4 s, 300 ms·2^n))` | same | same, cap 8 s |
| `Retry-After` (429/418) | honored, cap 120 s; provider cooldown | honored | honored |
| 429 / Bybit 403-burst | cooldown 30 s → ×2 → max 5 min | same | same |
| 418 (Binance ban) | cooldown = Retry-After, skip provider | same | alert |
| 451 / geo-403 / CORS | provider unusable for session; try next | provider unusable for 1 h (per PoP isolate) | alert + skip |
| Negative cache on failure | 10 s per (provider, endpoint) | return last-good or an error envelope `{ok:false}` with `Cache-Control: public, max-age=10`, so the edge absorbs a stampede; Workers Cache request collapsing also helps | 10 s |
| Circuit breaker | 3 consecutive failures → open 30 s | same | same |
| Budget guard | Binance: if `X-MBX-USED-WEIGHT-1M` > 3000, halve cadence; Bybit: if `X-Bapi-Limit-Status` < 20%, halve | same | same |

### 6.6 Polling cadences and the cross-tab model

| Stream | Cadence | Runs when |
|---|---|---|
| Crypto tickers (watchlist + terminal) | 5 s | any AureonX tab visible |
| Crypto depth (one symbol) | 2 s | a terminal for that symbol is visible |
| Crypto klines | on mount; at interval close + 1–2 s jitter (`limit=2`); ≥1h intervals every 60 s | terminal visible |
| FX/metals tickers (shared route) | 60 s | any tab visible |
| FX klines (shared route) | on mount; then `max(interval, 60 s)` | FX terminal visible |
| Daily FX reference | 15 min (data changes daily) | any tab visible |

**Cross-tab sharing (one upstream poller per browser):**
1. Each tab calls `navigator.locks.request('aureonx-md-leader', { mode: 'exclusive' }, () => new Promise(() => {}))`. The tab holding the lock is the leader. The lock is released when the tab closes or crashes, and the next tab takes over automatically. Web Locks are supported in all current major browsers. If the API is unavailable, fall back to a BroadcastChannel heartbeat election with a 3 s lease.
2. Followers post `{type:'interest', tabId, visible, symbols[], depthSymbol?, klines?: {symbol, interval}}` on `BroadcastChannel('aureonx-md')` whenever visibility or view changes. They also send a heartbeat every 10 s; interest expires after 25 s.
3. The leader polls the **union** of interests and posts `{type:'snapshot', kind, data}`. All tabs, the leader included, render from a shared in-memory store (e.g. a Zustand store fed by the channel).
4. **Pause rule:** the leader pauses each stream when no tab with interest in it is visible (`document.hidden` everywhere). On `visibilitychange` back to visible, refresh immediately.
5. SharedWorker was **not** chosen because Chrome on Android lacks it.
6. Within a single tab, components subscribe to the store and never fetch directly. A lint rule or code review enforces "no `fetch` to market hosts outside the md client".

---

## 7. Budget (10 users, terminals open 4 h/day, 30 days)

Assumptions (upper bound):
* One leader tab per user.
* A terminal is visible for the whole 4 h.
* 10 symbol or interval switches per hour.
* 10 × 4 h × 30 = **1,200 user-hours/month**.

### 7.1 Recommended design

**Crypto (browser-direct): upstream calls only, 0 Worker requests**

| Stream | Per user-hour | × 1,200 user-h | Binance weight per IP per min |
|---|---|---|---|
| Tickers 5 s (1 batched call) | 720 | **864,000** | 12 calls × 2 = 24 |
| Depth 2 s (limit 20) | 1,800 | **2,160,000** | 30 × 5 = 150 |
| Klines: 60 closes + 10 switches | 70 | **84,000** | ~1.2 × 2 ≈ 2.4 |
| **Total** | 2,590 | **≈ 3.11 M upstream calls/month**, spread across 10 user IPs | **≈ 176 / 6,000 (2.9%)** |

Bybit check: 2,590 calls/h ≈ 3.6 calls per 5 s, against a limit of 600 per 5 s.

**FX/metals (shared md Worker route): Worker requests**

| Stream | Per user-hour | × 1,200 | Notes |
|---|---|---|---|
| FX/metals tickers 60 s | 60 | 72,000 | mostly Workers Cache hits (billed as requests, no CPU) |
| FX klines (mount/switch) | 10 | 12,000 | |
| **Total Worker requests** | 70 | **≈ 84,000/month ≈ 2,800/day** | Free plan cap 100,000/day → 2.8% used; Paid: inside 10 M included → **$0 marginal** |

**FX/metals upstream calls (from the Worker, on cache misses only)**
* Metals: two calls (XAU + XAG) per refresh, TTL 30 s, gives at most 240 calls/hour while anyone is online.
  * Best case, users overlap in the same 4 h: 240 × 4 × 30 = **28,800/month**.
  * Worst case, someone is online all 24 h: 240 × 24 × 30 = **172,800/month**.
* Daily FX: TTL 900 s gives ≤ 4/h, so ≤ 96/day ≈ **2,900/month**.
* Tiered cache and request collapsing hold this to about one fill per TTL per cache key. A small multiple is possible across upper tiers. Placement can raise the miss count slightly but does not change the order of magnitude.

**Settlement oracle (Supabase)** — superseded at merge by the 10 s demand-gated `price-ingest` (`docs/data-model.md` §14: about 115 k invocations/month; 259 k if it ran nonstop). The 60 s figures below are kept for comparison only.
* pg_cron every 60 s, running only while unexpired options exist: 1,440 runs/day → **43,200 Edge Function invocations/month**.
* Each run makes 4 parallel batch-ticker calls: **172,800 upstream calls/month** from one IP. Binance weight is about 2 per minute, which is negligible.
* At-expiry captures add a few extra calls each.

**Grand total (recommended):**
* ≈ **84 k Worker requests/month**.
* ≈ **3.1 M browser upstream calls** (users' own IPs).
* ≈ **0.2–0.35 M server upstream calls** (metals 29–173 k + daily FX 3 k + oracle 173 k).
* ≈ **43 k Edge Function invocations**.

### 7.2 Comparator: route everything through the shared Worker

* Requests: (720 + 1,800 + 70 + 70) × 1,200 ≈ **3.19 M Worker requests/month ≈ 106 k/day**.
* That **exceeds the Workers Free plan's 100 k/day**. On Paid it fits inside the 10 M included.
* It would centralize geo-handling and shrink upstream calls to about one per TTL per key.
* Recommendation: keep it as the **automatic fallback for geo-blocked users only** (§3.2), not as the default.

---

## 8. Open decisions

**D1 — Near-real-time XAU/XAG source for display**
- (a) gold-api.com (free, claimed no key): *good:* simple, likely CORS-friendly · *bad:* unverified freshness and SLA; single hobby provider.
- (b) Tokenized gold (PAXG/XAUT) for XAU, plus daily currency-api for XAG: *good:* already in the crypto pipeline, 24/7, verifiable · *bad:* proxy basis ±0.1–0.2%; no real-time silver.
- (c) TwelveData free key, server-side only: *good:* official quotes · *bad:* 800/day cap allows about one refresh every 4 min for 2 symbols; key management.

**D2 — Forex terminal order book**
- (a) Synthetic display-only book around mid (fixed spread table per pair, geometric size ladder), always labelled "Indicative", `synthetic: true`, rejected by money paths: *good:* the terminal looks complete · *bad:* fabricated-looking data; users may mistake it for real liquidity.
- (b) Hide the depth panel for FX; show bid/ask/spread only: *good:* honest and simple · *bad:* layout differs from crypto terminals.
- (c) Show a "price ladder" of recent mid ticks instead of a book: *good:* real data · *bad:* sparse with 60 s/daily data; new component.

**D3 — Forex intraday klines**
- (a) Yahoo chart endpoint, server-side via md Worker with max-age ≥ 60 s: *good:* free 1m–1mo candles, no key · *bad:* unofficial, ToS risk, may break or block datacenter IPs.
- (b) TwelveData free key: *good:* official · *bad:* 800 credits/day cannot cover 8 pairs × 9 intervals; needs aggressive caching.
- (c) Daily-only FX charts in v1 (close-only from Frankfurter): *good:* official, free, stable · *bad:* no intraday charts for FX.

**D4 — Settlement aggregation tolerance (with the settlement agent)**
- (a) Median of ≥2, dispersion ≤ 50 bp: *good:* robust · *bad:* may return UNAVAILABLE during volatile spikes.
- (b) Median of ≥3, no dispersion check: *good:* rarely unavailable · *bad:* depends on 3 providers being reachable from one region.
- (c) Primary provider with secondary sanity check (±1%): *good:* simple · *bad:* single-source risk.

**D5 — FX/XAG options in v1**
- (a) Defer to v2 (crypto + XAU-proxy only): *good:* every settlement is fresh and verifiable · *bad:* smaller product.
- (b) Daily-fixing FX options settled at the reference rate: *good:* honest with free data · *bad:* only daily expiries; the fix time differs from the expiry UX.
- (c) Paid FX feed: *good:* full product · *bad:* cost and licence, out of scope for "free".

**D6 — Users in exchange-restricted regions (e.g. the US)**
- (a) Fallback Worker route with a Placement Hint in an EU region: *good:* works for everyone · *bad:* possible exchange-ToS concern; Worker requests grow.
- (b) Add a US-accessible crypto source to the chain (e.g. Coinbase Exchange or Kraken public REST; CORS and limits to measure): *good:* compliant data path · *bad:* more adapters.
- (c) Geo-gate the app: *good:* simplest compliance · *bad:* loses users.

**D7 — Where the md routes live**
- (a) Separate `aureonx-md` Worker on a route `app.example.com/md/*`, with Workers Cache and a Placement Hint: *good:* isolated billing, cache and placement; no cookies · *bad:* a second deployable.
- (b) Next.js route handlers inside the OpenNext Worker: *good:* one deployable · *bad:* enabling Workers Cache there bills every request including static assets, risks caching Next responses with `s-maxage`, and auth cookies cause bypass.

---

## 9. Anticipated conflicts with other agents

* **Data-model agent:**
  * Prices and quantities must be `numeric` in Postgres and strings on the wire. JS floats must never be used.
  * Simulated order fills, margin and liquidation must use a **server-fetched** price with freshness ≤ 10 s, never a price submitted by the client.
  * A table such as `price_snapshots(symbol, price, method, as_of, inputs jsonb, status)` is needed for settlement audit.
  * Options symbols must be limited to the v1-viable set (crypto + XAU-proxy) unless D5 changes.
  * Canonical symbol format `BASE/QUOTE` must be agreed.
* **UI agent:**
  * Badges "Live / Delayed / Indicative / Daily reference rate" are required, with no provider names.
  * The FX depth panel depends on D2.
  * FX sub-daily intervals may be disabled depending on D3.
  * The live candle is patched from the ticker, so the last bar can move between kline fetches.
  * Components must read from the shared store and **never fetch** market data directly.
* **Platform/infra:**
  * The md Worker needs `cache.enabled`, `placement.region`, and no Set-Cookie or auth middleware on `/md/*`.
  * The Supabase project or oracle region must be one the exchanges serve (EU suggested; measure).
  * The sandbox allowlist must be extended to re-run §1.4.
