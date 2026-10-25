# AureonX — Market Data Plan (planning phase)

> **Merged 2026-10-25.** Where this doc conflicts with `docs/decisions.md`, `docs/decisions.md` wins. Table, column and RPC names follow `docs/data-model.md`.

> Status: **planning only**. Nothing here is implemented. AureonX is a **simulated** trading platform (demo funds, no real money).
> "Money path" below means any code that changes simulated balances, positions, fills, margin, liquidation, or options settlement.
> Provider names appear here only as data sources. **UI copy must never show provider names or branding** (use labels like "Live", "Delayed", "Indicative", "Daily reference rate").

---

## 0. TL;DR

| Data type | Crypto (BTC/USDT, ETH/USDT, …) | Forex + metals (XAU/USD, EUR/USD, AUD/*, CAD/JPY) |
|---|---|---|
| **Tickers** | Browser-direct REST from **one leader tab** per browser, 5 s. Browser chain is **`data-api.binance.vision` → OKX only**: these are the only hosts that sent `Access-Control-Allow-Origin` to our origin. Then the shared Worker route | One **shared, edge-cached Worker route** (Workers Cache), 60 s client poll |
| **Klines** | Browser-direct (same two hosts) on mount + on interval close; live candle patched from ticker | Shared Worker route; **no free official intraday source** → open decision |
| **Depth** | Browser-direct (same two hosts), 2 s, **only for the visible terminal's symbol** | **No free forex depth exists** → display-only synthetic/indicative book is an open decision |
| **Settlement price** | Server-side (`price-ingest` Edge Function, region-pinned): **median of ≥2 fresh exchange prices**. From the sandbox's US-geolocated egress, Vision, OKX and KuCoin answered; `api.binance.com` returned 451 and Bybit returned 403 | **XAU only via tokenized-gold proxy** (PAXG/XAUT, measured live on 3 exchanges); **FX and XAG options not viable in v1** with free data |

The Worker route gets about **84 k requests a month** for 10 users at 4 h/day. Crypto polling never reaches the Worker. Section 7 shows the math.

**Measurement status (re-probe, 2026-10-25 08:10–08:13 UTC, sandbox egress):** after the owner allowlisted the exchange hosts and `api.frankfurter.app`, real calls were made (§1.2).

| Host | Result | CORS for our origin | Browser-direct? |
|---|---|---|---|
| `data-api.binance.vision` | 200 | `ACAO: *` on GET; **OPTIONS preflight → 403** | **Yes, simple GETs only** |
| OKX | 200 | Reflects any `Origin`; preflight answered | **Yes** |
| KuCoin | 200 | **No ACAO for our origin** (allowlists its own sites) | **Not browser-direct; server/Worker only** |
| `api.binance.com` | **451 restricted location** | — | No (from this egress) |
| Bybit | **403 "CloudFront … block access from your country"** | — | Not from US; unverified elsewhere |
| `api.frankfurter.app` | 301 → `api.frankfurter.dev` (still blocked here); the redirect carries no ACAO | — | — |

Every other FX/metals host (gold-api, metals.live, jsDelivr, pages.dev, exchangerate.host, open.er-api, Yahoo, TwelveData, Stooq) and the geo-IP echoes are **still blocked by the sandbox proxy**.

**Sandbox egress ≠ production.** These results come from a datacenter IP that geolocates to the US (inferred from CloudFront PoPs `ORD56`/`IAD61`, Cloudflare `cf-ray …-IAD`, and the 451/403 texts). Traffic also passes through a TLS-terminating proxy, which could in principle add, drop or alter headers, CORS headers included. None of this proves reachability or CORS behaviour from a user's browser or a deployed Worker. See §1.6 for the checks still required.

**Correction to the brief:** Cloudflare Cache Rules sit *behind* a Worker, not in front of it. They cannot stop a Worker from being invoked. Cloudflare has a newer feature, **Workers Cache**, that does sit in front. It serves hits without running the Worker, but **each hit is still billed as a Worker request** (no CPU time). Details and citations are in §5.

---

## 1. Measurements

### 1.1 Environment

| Item | Value |
|---|---|
| Measurement windows | Round 1: 2026-10-25 07:35–07:50 UTC, when everything was blocked. **Round 2: 08:10–08:13 UTC**, after the owner allowlisted `api.kucoin.com`, `www.okx.com`, `api.binance.com`, `data-api.binance.vision`, `api.bybit.com` and `api.frankfurter.app` |
| Tool | `curl 8.5.0` via sandbox HTTPS proxy (`/root/.ccr/ca-bundle.crt`, TLS verification on), `--compressed`, `Origin: https://aureonx.example` |
| Egress region | Geo-IP echoes (`ipinfo.io`, `www.cloudflare.com/cdn-cgi/trace`, …) are **still blocked by sandbox proxy**. **Inferred: United States, East/Central**, from four pieces of evidence: Binance's CloudFront PoP `x-amz-cf-pop: ORD56-P2` (Chicago); Bybit's `IAD61-P8` (Ashburn) plus its body "configured to block access from your country"; KuCoin and Frankfurter `cf-ray …-IAD`; and Binance's 451 restricted-location body. OKX routed internally to `x-routed-to: TKY`. |
| IP type | Datacenter/cloud egress shared with other sandbox sessions. Binance `x-mbx-used-weight-1m` climbed 14 → 90 → 125 across a handful of our weight-2/5 calls, so other tenants share the IP. |
| Proxy | TLS-terminating proxy between curl and upstream. Headers are assumed to pass through unmodified, but **that is not proven**, and it applies to CORS headers too. |
| Still blocked by sandbox proxy | `api.frankfurter.dev`, `api.gold-api.com`, `api.metals.live`, `api.exchangerate.host`, `cdn.jsdelivr.net`, `latest.currency-api.pages.dev`, `open.er-api.com`, `query1.finance.yahoo.com`, `api.twelvedata.com`, `stooq.com`, geo-IP echoes. Each returns `CONNECT 403 … no rule or allowlist entry allows host` |

> **Every result in §1.2–§1.3 is "sandbox egress".** A user's browser (residential IP, own country, real CORS enforcement) and a deployed Cloudflare Worker (Cloudflare egress IPs, PoP or placement region) can and will see different status codes, geo-blocks and possibly headers. §1.6 lists what must be re-verified.

### 1.2 Round-2 raw results (sandbox egress, US-geolocated datacenter IP)

GET and OPTIONS preflight were each sent with `Origin: https://aureonx.example`. The preflight added `Access-Control-Request-Method: GET` and `Access-Control-Request-Headers: content-type`. Latency is the curl `time_total` of the logged probe; where given, "p50 (5×)" is the median of 5 extra GETs at about 08:12 UTC. Bytes are decompressed. Every **Access-Control-\*** header returned is quoted verbatim; "absent" means the response had none.

| UTC | Provider / endpoint (sandbox egress) | GET status | GET s (p50 5×) | GET bytes | GET Access-Control-* (verbatim) | OPTIONS status | OPTIONS Access-Control-* (verbatim) | Rate-limit headers | Cache headers |
|---|---|---|---|---|---|---|---|---|---|
| 08:10:14 | KuCoin `/api/v1/market/allTickers` (tickers, 969 symbols) | 200 | 0.629 (0.415) | 96,603 | **absent** | 200 (1 B) | **absent** | `gw-ratelimit-limit: 2000`, `gw-ratelimit-remaining: 1967`, `gw-ratelimit-reset: 21198` | `cache-control: public,max-age=0`, `cf-cache-status: DYNAMIC`, `vary: Origin` |
| 08:10:15 | KuCoin `/market/orderbook/level1?symbol=BTC-USDT` (ticker) | 200 | 0.611 | 127 | **absent** | 200 | **absent** | `gw-ratelimit-*` (1992/2000) | `cf-cache-status: DYNAMIC`, `vary: Origin` |
| 08:10:17 | KuCoin `/market/candles?symbol=BTC-USDT&type=1min` (klines) | 200 | 0.389 (0.347) | 2,813 | **absent** | 200 | **absent** | `gw-ratelimit-*` (1952/2000, reset 5709 ms) | `public,max-age=0`, `DYNAMIC` |
| 08:10:17 | KuCoin `/market/orderbook/level2_20?symbol=BTC-USDT` (depth) | 200 | 0.344 (0.325) | 374 | **absent** | 200 | **absent** | `gw-ratelimit-*` (1974/2000) | `DYNAMIC` |
| 08:10:18 | KuCoin `/market/stats?symbol=PAXG-USDT` / `XAUT-USDT` | 200 / 200 | 0.314 / 0.323 | 216 / 215 | **absent** | 200 | **absent** | `gw-ratelimit-*` | `DYNAMIC` |
| 08:10:20 | OKX `/api/v5/market/tickers?instType=SPOT` (tickers, 1,195 instruments) | 200 | 0.364 (0.517) | 100,834 | `access-control-allow-origin: https://aureonx.example` | 200 (0 B) | `access-control-allow-origin: https://aureonx.example` · `access-control-allow-headers: content-type` · `access-control-allow-methods: GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS,TRACE,CONNECT` · `access-control-max-age: 3` | **none** | `cache-control: no-cache, no-store, max-age=0, must-revalidate`, `expires: 0`, `vary: Accept-Encoding, Origin`, `cf-cache-status: DYNAMIC` |
| 08:10:20 | OKX `/market/ticker?instId=BTC-USDT` | 200 | 0.302 | 242 | `access-control-allow-origin: https://aureonx.example` | 200 | same as above (`max-age: 3`) | none | same |
| 08:10:21 | OKX `/market/candles?instId=BTC-USDT&bar=1m&limit=100` (klines) | 200 | 0.306 (0.331) | 3,622 | `access-control-allow-origin: https://aureonx.example` | 200 | same (`max-age: 3`) | none | same |
| 08:10:22 | OKX `/market/books?instId=BTC-USDT&sz=50` (depth) | 200 | 0.357 (0.355) | 916 | `access-control-allow-origin: *` | 200 | `access-control-allow-origin: *` · `access-control-allow-headers: content-type` · `access-control-allow-methods: GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS,TRACE,CONNECT` · `access-control-max-age: 10` | none | `vary: Accept-Encoding`, `DYNAMIC` (no cache-control) |
| 08:10:22 | OKX `/market/ticker?instId=PAXG-USDT` / `XAUT-USDT` | 200 / 200 | 0.312 / 0.320 | 227 / 230 | `access-control-allow-origin: https://aureonx.example` | 200 | same (`max-age: 3`) | none | `no-cache, no-store…` |
| 08:10:24 | Binance `api.binance.com` `/api/v3/ticker/24hr?symbols=[…]` | **451** | 0.141 | 224 | **absent** | **451** | **absent** | none | `x-cache: Error from cloudfront`, `x-amz-cf-pop: ORD56-P2` |
| 08:10:25 | Binance `api.binance.com` `/klines`, `/depth`, `/ticker/bookTicker?symbol=PAXGUSDT` | **451** ×3 | 0.134–0.231 | 224 | **absent** | **451** | **absent** | none | `Error from cloudfront` |
| 08:10:26 | Binance Vision `/api/v3/ticker/24hr?symbols=[BTC,ETH,PAXG,XAUT]` (tickers) | 200 | 0.718 (0.715) | 683 | `access-control-allow-origin: *` · `access-control-allow-methods: GET, HEAD, OPTIONS` | **403** (nginx HTML) | **absent** | `x-mbx-used-weight: 14`, `x-mbx-used-weight-1m: 14` | `cache-control: no-cache, no-store, must-revalidate`, `expires: 0` |
| 08:10:28 | Binance Vision `/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=100` | 200 | 0.737 (0.720) | 4,493 | `access-control-allow-origin: *` · `access-control-allow-methods: GET, HEAD, OPTIONS` | **403** | **absent** | `x-mbx-used-weight-1m: 90` (shared IP) | same |
| 08:10:29 | Binance Vision `/api/v3/depth?symbol=BTCUSDT&limit=50` | 200 | 0.719 (0.716) | 629 | `access-control-allow-origin: *` · `access-control-allow-methods: GET, HEAD, OPTIONS` | **403** | **absent** | `x-mbx-used-weight-1m: 105` | same |
| 08:10:30 | Binance Vision `/api/v3/ticker/bookTicker?symbol=XAUTUSDT` | 200 | 0.720 | 119 | `access-control-allow-origin: *` · `access-control-allow-methods: GET, HEAD, OPTIONS` | **403** | **absent** | `x-mbx-used-weight-1m: 125` | same |
| 08:10:31 | Bybit `/v5/market/tickers?category=spot` (+ `symbol=BTCUSDT`, `PAXGUSDT`, `XAUTUSDT`) | **403** ×4 | 0.134–0.148 | 96 | **absent** | **403** | **absent** | none | `x-cache: Error from cloudfront`, `x-amz-cf-pop: IAD61-P8` |
| 08:10:32 | Bybit `/v5/market/kline`, `/v5/market/orderbook` | **403** ×2 | 0.138–0.140 | 96 | **absent** | **403** | **absent** | none | same |
| 08:10:34 | Frankfurter `api.frankfurter.app/latest?from=USD&to=…`, `/latest?from=XAU`, `/2026-10-01..`, `/currencies` | **301** → `https://api.frankfurter.dev/v1/…` | 0.149–0.411 | 167 | **absent** (on the redirect) | 301 | **absent** | none | none |
| 08:10:36 | `api.frankfurter.dev`, gold-api, metals.live, exchangerate.host, jsDelivr, pages.dev, open.er-api, Yahoo, TwelveData, Stooq, geo-IP echoes | **blocked by sandbox proxy** (CONNECT 403, curl `000`) | — | 0 | n/a | blocked | n/a | n/a | n/a |

Verbatim error bodies (sandbox egress):
* `api.binance.com` 451: `{"code": 0, "msg": "Service unavailable from a restricted location according to 'b. Eligibility' in https://www.binance.com/en/terms. Please contact customer service if you believe you received this message in error."}`
* Bybit 403: `{ error:The Amazon CloudFront distribution is configured to block access from your country }`. This is a **geo** block, not the rate-limit 403.
* Binance Vision OPTIONS 403: nginx HTML `403 Forbidden`, with `cache-control: no-cache, no-store, must-revalidate`.

**CORS follow-up probes** (08:11 UTC, sandbox egress, GET `orderbook/level1` / OKX `candles`):

| Probe | Result |
|---|---|
| KuCoin with `Origin: https://www.kucoin.com` | `access-control-allow-origin: https://www.kucoin.com` · `access-control-allow-methods: GET,POST,OPTIONS,PUT,DELETE` · `access-control-max-age: 5` · `access-control-expose-headers: **` · `access-control-allow-headers: Authorization,Cache-Control,Content-Type,KC-API-KEY,…,X-SITE-TYPE` · `access-control-allow-credentials: true` |
| KuCoin with `Origin: https://localhost:3000` or `null` | **absent** → KuCoin allowlists its own origins; **our origin will be refused by browsers** |
| OKX with `Origin: https://evil.example` or `https://aureonx-preview.pages.dev` | the same origin is echoed back → OKX reflects any origin (books: `*`) |
| Binance Vision OPTIONS without `Access-Control-Request-Headers` | still **403** → Vision supports **no preflight**; only CORS-"simple" GETs work |
| Binance Vision `HEAD /api/v3/ping` | 200, `access-control-allow-origin: *` |

**Payload freshness** (exchange timestamp vs the response `Date` header, which has 1 s resolution):

| Endpoint | Lag |
|---|---|
| OKX BTC ticker `ts` | 0.6 s |
| OKX books `ts` | ≈0 s |
| KuCoin allTickers `time` | ≈0 s |
| Vision BTCUSDT `closeTime` | 0.002 s |
| Vision PAXGUSDT `closeTime` | **26.9 s** (last *trade*, illiquid pair; the book was current) |
| Vision klines | last candle open = current minute (in-progress) |
| OKX klines | newest-first; `confirm` = `0` on the current bar, `1` on closed bars |
| KuCoin klines | newest-first, seconds; 100 rows returned without a `limit` parameter |

### 1.2a Tokenized gold, live (sandbox egress, 08:10 UTC)

| Pair | Vision (last · bid/ask) | OKX (last · bid/ask) | KuCoin (last · bid/ask) | Bybit / api.binance.com |
|---|---|---|---|---|
| PAXG/USDT | 4002.12 · 4002.11/4002.12 | 4003 · 4002.0/4002.2 | 4002.14 · 4002.13/4002.14 | 403 / 451 |
| XAUT/USDT | 3991.71 · 3991.70/3991.71 (spot listing **confirmed**) | 3992.3 · 3992.4/3992.5 | 3992.95 · 3992.94/3992.95 | 403 / 451 |

Observations:
* The three venues agree within about 2.5 bp per token.
* **PAXG trades about 25 bp above XAUT** (mid ≈ 4002.1 vs ≈ 3992.5). The median of the two tokens is ≈ 3997.3.
* For comparison, the daily currency-api XAU/USD (§1.3, date 2026-10-25) is 3993.62.
* So the token proxy carries a ±10–15 bp basis and is **indicative**, not spot.
* Use **bid/ask mid with fetch time** for freshness. Last-trade timestamps on PAXG can be 30 s or more old even when the book is live.

### 1.2b Round-1 results (07:43 UTC)

All 56 GET/OPTIONS calls returned `CONNECT 403 … no rule or allowlist entry allows host` from the sandbox proxy. This is superseded by Round 2 for the six allowlisted hosts and still current for the rest.

### 1.3 Real measurement: currency-api (fawazahmed0) via its npm mirror

This dataset is published daily as the npm package `@fawazahmed0/currency-api`. jsDelivr serves files from that package, so the npm tarball holds the same files the CDN URL returns ([README](https://github.com/fawazahmed0/exchange-api)). It is still the only FX/metals payload the sandbox can fetch: jsDelivr and pages.dev remain blocked in Round 2. This is sandbox egress via `registry.npmjs.org`.

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
    acao=$(grep -i '^access-control-' "$H" | tr -d '\r' | paste -sd'|' -)   # ALL Access-Control-* verbatim
    acam=$(grep -i -E '^(x-amz-cf-pop|cf-ray|x-routed-to|server):' "$H" | tr -d '\r' | paste -sd'|' -)  # where it was served
    hdr=$(grep -i -E '^(x-mbx-used-weight[^:]*|x-ratelimit[^:]*|ratelimit[^:]*|x-bapi-limit[^:]*|retry-after|cache-control|age|cf-cache-status|x-cache|expires|etag|last-modified):' "$H" | tr -d '\r' | paste -sd';' -)
    printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" "$(date -u +%FT%TZ)" "$prov" "$kind" "$method" "$out" "${acao:--}" "${acam:--}" "${hdr:--}"
    rm -f "$H"
  done
done
```

For OPTIONS, also add `-H "Access-Control-Request-Headers: content-type"` and repeat without it; Round 2 did both. Round 2 also added PAXG/XAUT tickers and KuCoin/OKX single-ticker rows.

**Acceptance gate before implementation:** for each crypto provider, from at least one EU and one US vantage point, record: GET status, all `Access-Control-*` headers on GET **and** OPTIONS, `x-mbx-used-weight-1m` / `x-bapi-limit*` / `gw-ratelimit-*` / other rate-limit headers, `Cache-Control`, and the payload timestamp lag. The real CORS test is a `fetch()` from a page served on the production origin, in a real browser (§1.6). curl only shows what the server sends.

### 1.5 What we know from primary docs (not measured here)

| Provider | Tickers | Klines | Depth | Rate limit (IP) | RL headers | Source |
|---|---|---|---|---|---|---|
| Binance (`api.binance.com`, `data-api.binance.vision`) | `/api/v3/ticker/24hr?symbols=[..]` weight 2 for 1–20 symbols, 40 for 21–100, max 100 symbols | `/api/v3/klines` weight 2, limit ≤1000 (default 500), **oldest→newest**, intervals `1s 1m 3m 5m 15m 30m 1h 2h 4h 6h 8h 12h 1d 3d 1w 1M` | `/api/v3/depth` weight 5 (limit ≤100), 25 (≤500), 50 (≤1000), 250 (≤5000) | `REQUEST_WEIGHT` 6000/min; 429 → back off; repeat → **418 IP ban**; `Retry-After` header | `X-MBX-USED-WEIGHT-1M` | [rest-api.md](https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md), [market_data_only.md](https://github.com/binance/binance-spot-api-docs/blob/master/faqs/market_data_only.md) |
| Bybit v5 | `/v5/market/tickers?category=spot` (all, or `symbol=`) | `/v5/market/kline` limit 1–1000 (default 200), intervals `1 3 5 15 30 60 120 240 360 720 D W M`, **newest→oldest** | `/v5/market/orderbook?category=spot` limit 1–200 | **600 req / 5 s per IP**, shared by `api.bybit.com` + `api.bytick.com`; violation → **HTTP 403, ~30 min ban** | `X-Bapi-Limit`, `X-Bapi-Limit-Status`, `X-Bapi-Limit-Reset-Timestamp` | [rate-limit.mdx](https://github.com/bybit-exchange/docs/blob/main/docs/v5/rate-limit.mdx), [kline.mdx](https://github.com/bybit-exchange/docs/blob/main/docs/v5/market/kline.mdx), [orderbook.mdx](https://github.com/bybit-exchange/docs/blob/main/docs/v5/market/orderbook.mdx), [guide.mdx](https://github.com/bybit-exchange/docs/blob/main/docs/v5/guide.mdx) |
| OKX v5 | `/api/v5/market/tickers?instType=SPOT` (all), `/market/ticker?instId=` | `/market/candles` limit ≤300, **newest→oldest**; daily+ bars default to UTC+8 unless suffixed `utc` (`1Dutc`) | `/market/books?sz=` | Per-endpoint per-IP (ccxt weights: tickers 1, candles/books ½); official numbers to be re-verified | **None returned** (measured, sandbox egress) → client must self-limit | [ccxt okx.ts](https://github.com/ccxt/ccxt/blob/master/ts/src/okx.ts) (secondary; official docs host blocked) |
| KuCoin | `/api/v1/market/allTickers` (ccxt cost 15) | `/api/v1/market/candles?type=1min` limit ≤1500, **newest→oldest**, row = `[t(sec), open, close, high, low, vol, turnover]` (**note the O-C-H-L order**, confirmed in a live payload) | `/market/orderbook/level2_20` / `level2_100` (public) | Measured: `gw-ratelimit-limit: 2000` with `gw-ratelimit-reset` < 30,000 ms → about 2000 weight / 30 s pool per IP | `gw-ratelimit-limit/-remaining/-reset` (measured) | [ccxt kucoin.ts](https://github.com/ccxt/ccxt/blob/master/ts/src/kucoin.ts) (secondary) |
| Frankfurter | Daily central-bank reference rates (ECB-based default blend, 200+ currencies, 100+ sources), `/v1/latest`, `/v2/*` | Daily time series only (one fix per day, no OHLC) | none | Not documented as strict | — | [frankfurter README](https://github.com/lineofflight/frankfurter) |
| currency-api | Daily, includes XAU/XAG/PAXG/XAUT (measured §1.3) | Daily snapshots by date URL | none | "No rate limits" | — | [exchange-api README](https://github.com/fawazahmed0/exchange-api) |
| TwelveData (free "Basic") | Needs an **API key**; 8 credits/min, **800/day** cap, resets 00:00 UTC; forex/crypto listed; XAU/USD coverage on free plan unverified | `time_series` 1min…1month | none | 800/day | — | [pricing](https://twelvedata.com/pricing), [credits](https://support.twelvedata.com/en/articles/5615854-credits) |
| gold-api.com, metals.live, exchangerate.host, open.er-api, Yahoo chart, Stooq | **Unverified this session** (hosts blocked, search found no primary docs). Yahoo chart is an **unofficial** endpoint (no SLA/ToS for API use). exchangerate.host now requires a key (to verify). | | | | | — |

**CORS (sandbox-egress evidence, §1.2).** CORS is the deciding fact for browser-direct.

| Host | What the server sent | Browser-direct status |
|---|---|---|
| `data-api.binance.vision` | `ACAO: *` on GET; no preflight (OPTIONS → 403) | Browser-direct **only** with CORS-simple GETs: no custom request headers, no `Content-Type`, no `Cache-Control` request header. `fetch(url, { cache: 'no-store' })` is fine because it adds no header. |
| OKX | Reflects any `Origin` (books: `*`); preflight answered with `max-age` 3–10 s | Browser-direct OK. |
| KuCoin | Allowlist of its own sites only | **Not browser-direct.** |
| `api.binance.com`, Bybit | Blocked before any CORS header (451 / 403 at CloudFront) | CORS **unknown**. Not browser-direct until §1.6 proves otherwise. |
| `api.frankfurter.app` | 301 with no ACAO | Browsers fail CORS on a cross-origin redirect without ACAO. Call `api.frankfurter.dev` directly (server-side; still unmeasured). |

### 1.6 Production reachability checks still required

None of the following is proven by sandbox egress. Each needs a check from (B) a **real browser** page on the production origin (check DevTools for CORS errors, not just status), from a US and a non-US residential IP, and/or from (W) a **deployed Cloudflare Worker** (record `cf-placement` / `cf-ray` colo) and the **`price-ingest` Supabase Edge Function** in its pinned region (record `x-sb-edge-region`).

| # | Endpoint / behaviour | Why it is still open | Needs |
|---|---|---|---|
| 1 | `api.binance.com` all endpoints: 451 for US | Seen from the US datacenter egress. Must confirm for US residential browsers, for non-US browsers (expected 200), and for Cloudflare/Supabase egress in the EU placement region. CORS headers never observed. | B (US + EU), W |
| 2 | Bybit all endpoints: CloudFront 403 "block access from your country" | Seen from US egress. Unknown from EU, from Cloudflare egress IPs (reported cloud-range blocks), or from Supabase EU. CORS never observed. | B (EU), W |
| 3 | `data-api.binance.vision`: 200 from US egress | Could differ for residential vs datacenter IPs and other countries. Re-confirm `ACAO: *` arrives unmodified without the proxy, and that a real `fetch()` with no custom headers succeeds while one with a custom header fails (no preflight). | B (US + EU), W |
| 4 | OKX `www.okx.com`: 200 + origin reflection from US egress | Global OKX is restricted for US residents. The browser behaviour from US/EEA residential IPs is unverified (e.g. redirects to `my.okx.com` / `app.okx.com`). Re-confirm reflection for the real production origin. | B (US + EU), W |
| 5 | KuCoin: 200 from US egress despite the Jan-2025 US-IP restriction | The API may still block US residential IPs. Confirm from Supabase EU (server-side use only). Confirm ACAO stays absent for our origin (already enough to rule out browser-direct). | W, Supabase |
| 6 | `api.frankfurter.dev` | Still blocked in the sandbox; status, CORS and freshness unmeasured. | W (+ B if ever browser-direct) |
| 7 | gold-api, metals.live, exchangerate.host, open.er-api, jsDelivr/pages.dev currency-api, Yahoo chart, TwelveData, Stooq | Still blocked in the sandbox; nothing measured live except currency-api via npm. | W (all FX/metals go through the md Worker) |
| 8 | Workers Cache + Placement Hint behaviour | `cf-cache-status: HIT` with no Worker CPU; that misses run near `aws:eu-central-1` (`cf-placement: remote-FRA`-style header); that Binance and Bybit answer 200 from there. | W |
| 9 | `price-ingest` egress | Whether ≥2 crypto sources and ≥2 PAXG/XAUT venues answer from the pinned Supabase region. From US egress, Vision, OKX and KuCoin did; Bybit and `api.binance.com` did not. | Supabase |
| 10 | Proxy header integrity | The sandbox TLS-terminating proxy could alter headers. Every CORS/rate-limit conclusion above must be re-read from a non-proxied client. | B or W |

---

## 2. Coverage matrix (needed pairs)

| Pair | Free real-time (<60 s) source | Free daily source | Notes |
|---|---|---|---|
| BTC/USDT, ETH/USDT, other crypto spot | Browser: Vision, OKX. Server: Vision, OKX, KuCoin (+ Bybit and `api.binance.com` where not geo-blocked). All have tickers, klines and depth | — | Region-dependent (§4, §1.6) |
| **XAU/USD** | **PAXG/USDT, XAUT/USDT, measured live on Vision, OKX and KuCoin** (§1.2a; 24/7 proxy; 1 token ≈ 1 troy oz; PAXG ≈ +25 bp vs XAUT; median ≈ +10 bp vs the daily reference). gold-api (claimed real-time, still blocked/unverified). TwelveData (key, 800/day) | currency-api (measured), Frankfurter (XAU not expected; `.dev` unmeasured) | Tokenized gold ≠ spot XAU; label "Indicative" |
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

* **Crypto: browser-direct**, from the leader tab only, every **5 s** while any AureonX tab is visible. **Only `data-api.binance.vision` and OKX qualify** on CORS evidence (§1.5). Changed after Round 2:
  * KuCoin is **removed** from the browser chain because it sends no ACAO to our origin.
  * Bybit and `api.binance.com` are **removed pending §1.6**: geo-blocked from the probe egress, CORS never observed.
  * One batched call per cycle:
    * Vision: `ticker/24hr?symbols=[…]` with ≤20 symbols costs weight 2; larger lists go in chunks of 20.
    * OKX: `market/tickers?instType=SPOT` returns all ~1,195 instruments in ~100 KB. That is heavy every 5 s, so use per-symbol `market/ticker` only for ≤5 symbols, otherwise the all-tickers call at 10 s.
  * Vision rule: **CORS-simple GET only**. No custom request headers and no `Content-Type` on GET, because Vision answers every preflight with 403.
  * Rate limits are per **user IP**, so per-user browser polling spreads load naturally and never touches our Worker. OKX returns **no rate-limit headers**, so the client must self-limit (§6.5).
  * If a provider fails CORS, or is geo-blocked for this user (451 / geo-403), the leader moves to the next provider (§6.4). If **both** browser providers fail, the client switches to the md Worker's crypto route (`/md/v1/crypto/tickers`).
    * That route is cached at max-age=5 and served by a Worker placed (Placement Hint) in a region the exchanges serve.
    * It is the *only* case where crypto traffic reaches the Worker, and it is still one shared cached URL.
    * It is also where KuCoin, and Bybit/`api.binance.com` (if reachable from the placement region), contribute.
* **Forex/metals: shared Worker route** `GET /md/v1/fx/tickers?set=core`. Use one fixed URL per symbol set so every client shares the same cache key and the query string is never user-built. Client polls every **60 s**.
  * Upstream (decided by Open decision D1): daily reference (Frankfurter → currency-api fallback), plus XAU/XAG from the chosen near-real-time source, plus PAXG/XAUT mid from the crypto providers as an XAU proxy.
  * Response header `Cache-Control: public, max-age=30, stale-while-revalidate=30`. For a daily-only set, use `max-age=900, stale-while-revalidate=3600`.
* **Never** feed browser-fetched prices into a money path. The server re-fetches its own prices.

### 3.3 Klines

* **Crypto: browser-direct** via Vision (`ACAO: *` on klines, measured) or OKX (origin reflected on candles, measured). KuCoin klines go through the Worker fallback only.
  * On terminal mount or symbol/interval change: one fetch with limit 500 (Vision) or 300 (OKX), normalized to oldest→newest.
  * At each interval close + 1–2 s jitter: re-fetch only the last 2 candles (`limit=2`).
  * Between closes, the **live candle is patched from the ticker stream** (display-only: update close/high/low). This avoids per-second kline polling.
  * For ≥1h intervals, re-fetch the last 2 candles every 60 s.
* **Forex: shared Worker route** `GET /md/v1/fx/klines?symbol=EUR-USD&interval=1h`, `max-age = min(interval, 300)`. Source is Open decision D3. If no intraday source is approved, show daily close-only candles labelled "Daily reference" and disable sub-daily intervals for forex in v1.

### 3.4 Depth

* **Crypto: browser-direct** via Vision `depth` (`ACAO: *`, measured) or OKX `books` (`ACAO: *`, measured), every **2 s**, and **only** for the symbol in a visible terminal. Limit 20 (Vision weight 5). KuCoin `level2_20` goes through the Worker fallback only (no ACAO).
  * With no visible terminal: no depth polling.
  * Hidden document: pause.
  * The best bid/ask from depth also refreshes the terminal header price between ticker polls.
* **Forex: no free depth source exists** (OTC market). This is Open decision D2. Whatever is chosen must be **display-only** and labelled "Indicative". It must never be used for fills, slippage or margin.

### 3.5 Settlement price (input to the settlement agent's design)

* **Server-side only.** Merged with the data model: there is one Edge Function, `price-ingest` (`docs/data-model.md` §7), run every 10 s by pg_cron while there is demand. The validation rules below run inside it before it calls `ingest_prices`; the database then applies its own freshness checks (≤15 s for entry and fills, at-or-after expiry and ≤60 s for settlement). It is invoked from pg_cron with `x-region` / `forceFunctionRegion` pinned to a region the exchanges serve (EU first; measure). Region pinning is documented in [Supabase regional invocation](https://supabase.com/docs/guides/functions/regional-invocation). Without pinning, a function runs nearest the caller. Verify via the `x-sb-edge-region` response header.
* **Crypto options:**
  * Price = **median** of the bid/ask **mid** from ≥2 of {Binance `data-api.binance.vision`, OKX, KuCoin, Bybit, `api.binance.com`}.
    * From the US-geolocated sandbox egress, Vision, OKX and KuCoin all answered with sub-second timestamps.
    * Bybit (403) and `api.binance.com` (451) did not.
    * So ≥2 sources is achievable even if the pinned region turns out to be US-geolocated. EU pinning stays recommended so the last two also count (verify, §1.6 #9).
    * CORS is irrelevant server-side.
  * Each source must have an exchange timestamp ≤ **30 s** old and a fetch ≤ **10 s** ago.
  * Sources must agree within ≤ **50 bp** of the median (threshold = Open decision D4).
  * Fewer than 2 qualifying sources → status `UNAVAILABLE` → retry with backoff until expiry + grace. The settlement agent defines the policy after that (e.g. void or postpone). **Never** settle on a stale or single unchecked price.
* **XAU options:** only via the **tokenized-gold proxy**: median of PAXG/USDT and XAUT/USDT across exchanges, converted with USDT≈USD (or divided by USDC/USDT if available).
  * Live check (§1.2a, sandbox egress): both tokens are quoted on Vision, OKX and KuCoin; the venues agree within ~2.5 bp; PAXG sits ~25 bp above XAUT.
  * Compute a median **per token across venues**, then the mean of the two token medians. Freshness comes from the bid/ask mid and fetch time; PAXG last-trade timestamps were 27 s old.
  * This is fresh (24/7) but is a *proxy*: the basis to the daily XAU reference was −15 bp/+6 bp (§1.3). Product copy must say "settles to the indicative gold reference" and never name the token or exchange.
* **FX options (EUR/USD, AUD/*, CAD/JPY) and XAG options: not viable in v1** with free data. The free official sources are daily. The only free intraday option is an unofficial endpoint (Yahoo chart). The keyed free tier (TwelveData) has 800 calls/day, about one refresh every 14 min for 8 pairs, which fails the <60 s requirement. Recommendation: defer, or settle FX options **daily** at the reference-rate fix (Open decision D5).

---

## 4. Regional restrictions (API level)

| Provider | What is known | Evidence quality |
|---|---|---|
| **Binance** `api.binance.com` | Returns **HTTP 451 "Service unavailable from a restricted location"** to US IPs, and reportedly to some cloud/datacenter ranges (a US Linode got 451, Frankfurt did not; Railway reports US/NL/SG ranges affected). Restrictions on public market data date from late 2022. **Measured (sandbox egress, US):** 451 on every endpoint, from CloudFront PoP ORD56, with the body quoted in §1.2. | Measured + community reports: [Linode](https://www.linode.com/community/questions/23972/linode-and-binancecom), [Vercel](https://community.vercel.com/t/binance-api-calls-on-vercel/29895), [Railway](https://station.railway.com/questions/deployment-is-crashing-7b190d57), [CryptoDataDownload](https://www.cryptodatadownload.com/blog/posts/binance-download-data-python-usa-residents/) |
| Binance `data-api.binance.vision` | Official market-data-only host (no key); docs list no geo limits. **Measured (sandbox egress, US): 200 on tickers/klines/depth/bookTicker** while `api.binance.com` returned 451. Residential and other regions not yet verified. | Measured + [market_data_only.md](https://github.com/binance/binance-spot-api-docs/blob/master/faqs/market_data_only.md) |
| **Bybit** | The service agreement excludes the US, Canada, Singapore, Hong Kong and Mainland China, among others ([help center](https://bybit.com/en/help-center/article/Service-Restricted-Countries)). Cloud/US IPs reportedly get **HTTP 403 at the CDN edge** before auth ([QuotaGuard, vendor blog](https://quotaguard.com/blog/bybit-api-403-cloud-platform-cdn-block-fix)). **Measured (sandbox egress, US): 403 on every endpoint** from CloudFront IAD61, body "The Amazon CloudFront distribution is configured to block access from your country". Docs tell NL users to use `api.bybit.nl` and HK users `api.bybit.com.hk`; `api.bybit.com` "has the possibility to be shutdown at any time" for them ([guide.mdx](https://github.com/bybit-exchange/docs/blob/main/docs/v5/guide.mdx)). Note: Bybit's *rate-limit* ban is also a 403, so a 403 is ambiguous. Treat 403 with no JSON body as geo/edge-block and 403 after a burst as rate ban. | Official + vendor |
| **OKX** | Separate regional platforms: global `www.okx.com`, EEA `my.okx.com`, US `app.okx.com` / `us.okx.com` ([okx-api SDK regions](https://www.mintlify.com/tiagosiebler/okx-api/guides/regions), [ccxt OKX US](https://docs.ccxt.com/docs/comparisons/ccxt-vs-okxus-api)). Global service is restricted for US residents. **Measured (sandbox egress, US): 200 on all public market endpoints** (`x-routed-to: TKY`). Residential US behaviour is unverified. | Measured + secondary |
| **KuCoin** | Announced on 2025-01-16 that **access from US IP addresses is restricted** effective 2025-01-23 ([announcement](https://kucoin.com/announcement/us-ip-access-restrictions-and-guidance-on-asset-withdrawals-for-users-in-the-united-states)). **Measured (sandbox egress, US): 200 on public market endpoints**, so the restriction appears to target the site and accounts rather than the public REST API, at least for this IP. | Measured + official (web) |
| Frankfurter / currency-api | No geo restrictions documented. | Docs |

**Implications for our topology:**

* **Browser-direct:** the user's own IP decides. From US datacenter egress, `api.binance.com` (451) and Bybit (403) failed, while Vision and OKX (both CORS-enabled) and KuCoin (no CORS) worked. So the browser chain Vision → OKX plausibly covers US users too, but this is **unverified for residential IPs** (§1.6). The region-fallback route in §3.2 stays as the safety net. Whether US users are a target audience at all is a product and compliance question; see D6.
* **Cloudflare Workers** run in the PoP nearest the user by default, so a Worker hit by a US user that misses cache fetches upstream from a **US** PoP and may get 451. Mitigation: a **Placement Hint** `placement.region = "aws:eu-central-1"` (or `aws:ap-northeast-1`) on the md Worker. Its `fetch` handler then runs near that region on cache misses ([placement docs](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/workers/configuration/placement.mdx)). Workers Cache lower and upper tiers are consulted *before* placement, so hits stay local ([Workers Cache: Smart placement and the cache](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/workers/cache/index.mdx)). Cloudflare egress IPs can still be flagged as "datacenter" by exchanges, so this must be measured.
* **Supabase Edge Functions** run nearest the caller unless pinned via `x-region`. Pin the oracle to an EU region and measure from it.
* **Compliance note:** using placement or regions to *circumvent* an exchange's geo-restriction for users in restricted jurisdictions may violate that exchange's terms. AureonX only displays public reference data for a simulator and never trades on these exchanges, but legal should confirm. This is D6.

### Browser-direct websockets (alternative, not the default)

Binance `wss://data-stream.binance.vision/ws/<sym>@kline_1m`, Bybit `wss://stream.bybit.com/v5/public/spot`, OKX `wss://ws.okx.com:8443/ws/v5/public`. KuCoin requires a `POST /api/v1/bullet-public` token first, which needs CORS (measured: absent for our origin) or a server.

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
| XAUT/USDT (XAU proxy) | `XAUTUSDT` (spot listing confirmed on Vision) | `XAUT-USDT` (live) | `XAUTUSDT` (unverified: 403) | `XAUT-USDT` (live) |

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
| Crypto ticker | `now − sourceTs ≤ 15 s`. For illiquid pairs (PAXG/XAUT), `sourceTs` = fetch time of a book-derived mid, because last-trade time lagged 27 s while the book was live | 15–60 s | > 60 s or 2 failed cycles | **never** uses client data; server needs ≤ 10 s (fills; data-model agent) / ≤ 30 s per input (settlement) |
| Crypto depth | ≤ 6 s (3 cycles) | grey out book > 6 s | > 15 s | never |
| Crypto klines | last closed candle ≤ 2 × interval old | badge | > 3 × interval | never |
| XAU/XAG near-real-time | ≤ 60 s | 60–300 s | > 300 s → fall back to `indicative` token-gold | XAU settlement via token-gold only (§3.5) |
| FX daily reference | n/a (grade `reference`; show "as of <date>") | date older than last business day + 1 | after 2 business days | not used in v1 |
| Synthetic FX book | always `indicative` | — | — | **rejected** (`synthetic: true`) |

UI copy, which the UI agent owns: "Live", "Delayed", "Indicative", "Daily reference rate · as of 24 Oct". No provider names.

### 6.4 Fallback order per asset class

* **Crypto (browser):** `binanceVision → okx`, then the md Worker region-fallback route. Updated after Round 2, which removed `bybit` and `kucoin` from the browser chain.
  * `binanceVision` comes first: official market-data-only host, `ACAO: *`, weight headers present. Its p50 latency was 0.72 s vs OKX 0.33 s from the sandbox; re-measure from browsers before fixing the order.
  * `okx` reflects the origin and answers preflights, but returns no rate-limit headers.
  * `kucoin` is excluded because it sends no ACAO to our origin. `bybit` and `api.binance.com` are excluded until §1.6 #1–2 show 200 **and** ACAO from real browsers.
  * The provider that succeeded is remembered per browser (per-viewer localStorage convenience, wrapped in try/catch), with a 1 h TTL. `geo_blocked` and `cors` mark a provider *unusable for this session*.
* **Crypto (Worker fallback route):** `binanceVision, okx, kucoin`, plus `bybit` / `binance` if they answer from the placement region.
* **Crypto (server / `price-ingest`):** query `binanceVision, okx, kucoin, bybit, binance` **in parallel** and take the median of qualifying inputs (§3.5). Geo-blocked responses (451, Bybit CloudFront 403) are classified `geo_blocked` and skipped without counting as failures.
* **XAU:** near-real-time source (D1) → token-gold median (`PAXG/USDT`, `XAUT/USDT`) → currency-api daily (`reference`).
* **XAG:** near-real-time source (D1) → currency-api daily (`reference`).
* **FX:** intraday source (D3, if any) → Frankfurter `.dev` → currency-api jsDelivr → currency-api `pages.dev` (the README recommends this fallback).
  * Frankfurter `.app` was removed as a fallback: Round 2 showed it is only a 301 redirect to `.dev`, so it is not independent.
  * All FX calls are server-side in the md Worker. None of these hosts has been measured live yet (§1.6 #6–7).

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
| Budget guard | Binance: if `X-MBX-USED-WEIGHT-1M` > 3000, halve cadence. Bybit: if `X-Bapi-Limit-Status` < 20%, halve. KuCoin: if `gw-ratelimit-remaining` < 400 of 2000, halve. **OKX sends no RL headers**: cap at ≤ 5 req/s per IP client-side and treat HTTP 429 / code `50011` as `rate_limited`. On shared egress (Worker, Supabase), the weight header reflects other tenants on the same IP too (seen in the sandbox), so act on it rather than on our own count | same | same |

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

OKX fallback check: 2,590 calls/h ≈ 0.7 req/s per user IP, under the ≤ 5 req/s self-limit.

Bandwidth (measured payload sizes, sandbox egress):

| Call | Size | Per user-hour |
|---|---|---|
| Vision 4-symbol ticker | 683 B | ≈ 0.5 MB/h |
| Vision depth (limit 50; limit 20 is smaller) | 629 B | ≈ 1.1 MB/h |
| OKX all-SPOT tickers, if used | 100.8 KB | **≈ 72 MB/h at 5 s**, which is why §3.2 limits it to 10 s or to per-symbol calls |

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
- (b) Tokenized gold (PAXG/XAUT) for XAU, plus daily currency-api for XAG: *good:* already in the crypto pipeline, 24/7, **measured live on 3 venues with browser CORS on 2** (§1.2a) · *bad:* proxy basis ±0.1–0.2% (PAXG–XAUT spread ~25 bp); no real-time silver. **This is now the strongest option on evidence**, since (a) and (c) remain unmeasured.
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

Round-2 context (sandbox egress, US datacenter IP): Vision, OKX and KuCoin answered; `api.binance.com` and Bybit did not. If §1.6 confirms the same for US residential browsers, the Vision → OKX browser chain may serve US users without the fallback route.
- (a) Fallback Worker route with a Placement Hint in an EU region: *good:* works for everyone · *bad:* possible exchange-ToS concern; Worker requests grow.
- (b) Add a US-accessible crypto source to the chain (e.g. Coinbase Exchange or Kraken public REST; CORS and limits to measure): *good:* compliant data path · *bad:* more adapters.
- (c) Geo-gate the app: *good:* simplest compliance · *bad:* loses users.

**D8 — Primary browser provider for crypto (new after Round 2)**
- (a) Vision first, OKX second: *good:* `ACAO: *`, weight headers for self-throttling, batched multi-symbol tickers · *bad:* no preflight support; 2× higher latency from the sandbox (0.72 s vs 0.33 s).
- (b) OKX first, Vision second: *good:* lower latency, preflights work · *bad:* no rate-limit headers; the all-tickers payload is large (100 KB); global OKX is restricted for US residents.
- (c) Race both on the first cycle per session and keep the faster healthy one: *good:* adapts per user region · *bad:* doubles the first-cycle load; more code.

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
  * The sandbox allowlist now covers the exchanges and `api.frankfurter.app`. FX/metals hosts (`api.frankfurter.dev`, gold-api, jsDelivr, …) are still blocked, so they must be measured from a deployed Worker (§1.6).
  * Before launch, run the §1.6 checks from a real browser on the production origin and from the deployed md Worker and `price-ingest` function.
* **All agents (md client code):** browser requests to Vision must be CORS-simple GETs: no custom headers, no `Content-Type`, no `Cache-Control` request header, because Vision rejects every preflight with 403. Any shared fetch wrapper that injects headers (auth, tracing, Supabase `apikey`) must not wrap market-data calls.
