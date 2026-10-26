# AureonX: UI map (planning)

> **Merged 2026-10-25.** Where this doc conflicts with `docs/decisions.md`, `docs/decisions.md` wins. Table, column and RPC names follow `docs/data-model.md`.

> AureonX is a multi-asset trading platform on **virtual funds**. An admin credits virtual balances and no real money moves. This file maps every screen to its route, layout, rendering mode, auth requirement, components and data source. It is a plan only: no app code exists yet.
>
> Research date: 2026-10-25. Versions found on npm on that date: `next@16.4.3` (the scaffold already pins this), `@opennextjs/cloudflare@1.20.13` (peer range `next >=15.5.28 <16 || >=16.4.1`), `@supabase/supabase-js@2.118.0`, `@supabase/ssr@0.12.7`, `lightweight-charts@5.2.1`, `next-intl@4.14.9`, `motion`/`framer-motion@14.6.0`, `@sentry/nextjs@11.9.0`, `tailwindcss@4.3.3`, `shadcn@4.22.1`.

---

## 0. Ground rules this map enforces

| # | Rule | How the UI obeys it |
|---|------|---------------------|
| R1 | Market data comes from the browser, through one shared store | All market widgets read from a single client `MarketDataProvider` (designed by the market-data agent). Components subscribe with `useTicker(symbol)`, `useOrderBook(symbol)`, `useTrades(symbol)` and `useCandles(symbol, tf)`. **No component calls fetch or opens a WebSocket for market data itself.** The provider dedupes by `(stream, symbol)` and reference-counts subscribers across components. A `BroadcastChannel` leader election shares one upstream connection across browser tabs (the provider owns this). |
| R2 | User data is read from Supabase under RLS; live updates come from Realtime | Hooks call `supabase.from(...).select()` once on mount, then patch state from a Realtime subscription. Channel names are `${topic}:${crypto.randomUUID()}`, created per mount and removed on unmount. **No polling of any Next.js route.** |
| R3 | Writes go through Supabase RPCs | Every mutation goes through `supabase.rpc('<name>', args)`. Server actions are used only where a secret is required (§5.3). |
| R4 | The proxy covers protected routes only and verifies the JWT locally | See §1.3. `getClaims()` verifies an asymmetric JWT with WebCrypto against a JWKS it caches in memory for 10 minutes. It falls back to the network only when the token has expired (refresh), when the JWKS cache is cold, or when the project still uses HS256. |
| R5 | Public pages are static, with no ISR | Marketing and auth pages are prerendered. App pages are also static shells that load their data in the browser. Only the auth callback route handlers and server actions run per request. `next/image` is set to `unoptimized` (already true in `next.config.ts`). |

---

## 1. Routing

### 1.1 The locale decision: no `[locale]` segment for now

**Recommendation: use next-intl's "without i18n routing" setup.** `src/i18n/request.ts` returns `locale: 'en'` as a constant and does not read `cookies()` or `headers()`. There is no `[locale]` folder and no next-intl middleware.

- Reasoning: next-intl's getting-started guide treats `[locale]` routing as optional ("If your app doesn't require unique pathnames per locale, you can provide a locale ... based on user preferences or other application logic"). With a constant locale, nothing reads request data, so every page stays statically renderable. The proxy matcher then only has to cover protected routes; it never runs on public pages to negotiate a locale.
- Sources: <https://next-intl.dev/docs/getting-started/app-router> ("Next steps → Provide a locale") and <https://next-intl.dev/docs/routing/setup#static-rendering>.
- Adding a second locale later means moving `src/app/*` under `src/app/[locale]/` with `generateStaticParams` and `next/root-params`, which next-intl recommends for static rendering, plus a `localePrefix: 'as-needed'` middleware. That is a mechanical move because route groups sit under the segment unchanged. The `[locale]` alternative is logged in Open Decisions D1.
- Do **not** read the locale from a cookie in `request.ts` (the doc's example). That reads `cookies()` and makes every page dynamic.

### 1.2 Folder layout

```
src/
  proxy.ts            (or middleware.ts, see Open Decision D2)
  i18n/request.ts     (constant 'en')
  app/
    layout.tsx                 RootLayout: <html>, next/font, ThemeProvider, NextIntlClientProvider, Toaster (sonner), SupabaseProvider, MarketDataProvider (client)
    not-found.tsx              Global 404 (static)
    global-error.tsx           Root error boundary (client; Sentry.captureException)
    (marketing)/
      layout.tsx               MarketingNavbar + Footer + SupportWidget
      page.tsx                 /
      legal/terms/page.tsx     /legal/terms
      legal/privacy/page.tsx   /legal/privacy
      legal/risk/page.tsx      /legal/risk  ("virtual funds" disclosure + chart library attribution notice)
    (auth)/
      layout.tsx               AuthShell (centered card, logo, VirtualFundsNote)
      sign-in/page.tsx         /sign-in
      sign-in/mfa/page.tsx     /sign-in/mfa  (AAL2 challenge: TOTP / phone / passkey)
      sign-up/page.tsx         /sign-up
      forgot-password/page.tsx /forgot-password
      update-password/page.tsx /update-password (lands here from the recovery link)
      auth/callback/route.ts   /auth/callback  (PKCE code exchange, sets cookies, redirects)
      auth/confirm/route.ts    /auth/confirm   (verifyOtp token_hash for email confirm/recovery links)
    (app)/
      layout.tsx               AppShell: AppHeader (TopNav + AssetMgmtMenu + VirtualFundsBadge + UserMenu), MobileTabBar
      error.tsx                Segment error boundary
      spot/page.tsx            /spot?symbol=BTC-USDT
      spot/loading.tsx
      forex/page.tsx           /forex?symbol=XAU-USD
      options/page.tsx         /options?symbol=BTC-USDT
      assets/page.tsx          /assets  (My Assets)
      assets/deposit/crypto/page.tsx
      assets/deposit/fiat/page.tsx
      assets/withdraw/crypto/page.tsx
      assets/withdraw/fiat/page.tsx
      assets/transfer/page.tsx
      assets/bills/page.tsx
      account/page.tsx         /account (Profile)
      account/security/page.tsx
      account/kyc/page.tsx
    admin/
      layout.tsx               AdminShell (Sidebar; role gate in proxy + client guard)
      error.tsx
      page.tsx                 /admin (queue counts dashboard)
      users/page.tsx           /admin/users           (?id=<uuid> opens the detail panel)
      deposits/page.tsx        /admin/deposits
      withdrawals/page.tsx     /admin/withdrawals
      kyc/page.tsx             /admin/kyc             (?id=<submission> opens the review panel)
      options-config/page.tsx  /admin/options-config
      audit/page.tsx           /admin/audit
```

The terminals carry the symbol in a query string (`/spot?symbol=BTC-USDT`) and not as a `[symbol]` segment. Each terminal is therefore **one static HTML file**. The page reads `useSearchParams()` inside a `<Suspense>` boundary in a client component. Switching symbols calls `window.history.replaceState`, which Next.js syncs with `useSearchParams`, so there is no RSC fetch and no Worker invocation. A `[symbol]` segment would cost a Worker request per symbol switch and would need `generateStaticParams` from a list fixed at build time (Open Decision D3). Admin detail views use `?id=` for the same reason.

### 1.3 Proxy / auth gate

- **Matcher (protected only):** `['/spot', '/forex', '/options', '/assets/:path*', '/account/:path*', '/admin/:path*']`. Public pages, `/_next/*`, static assets and the auth routes never run the proxy.
- **Logic:**
  1. Create `createServerClient` (`@supabase/ssr`).
  2. Call `supabase.auth.getClaims()`.
  3. If there are no claims, redirect to `/sign-in?next=<path>`.
  4. For `/admin/*`, require `claims.user_role === 'admin'` (top-level claim set by the custom access token hook, `docs/data-model.md` §4.5) and redirect to `/spot` otherwise.
  5. For `/admin/*`, also require `claims.aal === 'aal2'`, and redirect to `/sign-in/mfa` otherwise. Regular users who have enrolled factors are stepped up client-side: `(app)/layout` calls `supabase.auth.mfa.getAuthenticatorAssuranceLevel()`, which works from the local session, and redirects when `nextLevel === 'aal2' && currentLevel === 'aal1'`. The withdraw RPCs also check `auth.jwt()->>'aal' = 'aal2'` in SQL.
  6. Return the `supabaseResponse` that carries the refreshed cookies and cache headers.
- **Is it a network call?** In the common case, no. In `@supabase/auth-js@2.118.0`, `getClaims()` decodes the JWT, then calls `fetchJwk(kid)`. That function reads an in-memory `GLOBAL_JWKS` (TTL `JWKS_TTL = 10 min`) and fetches `/.well-known/jwks.json` only when the key is missing or stale. It then verifies with `crypto.subtle.verify`. It falls back to `getUser()` (a network call) only if `alg` is HS* (a legacy symmetric secret) or WebCrypto is missing. Separately, it refreshes the session first (a network call) if the access token is expired or about to expire, which happens once per token lifetime. To remove the cold-isolate JWKS fetch entirely, pass the project JWKS from an env var: `getClaims(undefined, { jwks: JSON.parse(env.SUPABASE_JWKS) })` ("this JSON Web Key Set is going to have precedence over the cached value"). The cost is redeploying when keys rotate; Supabase warns that long caching makes revocation harder.
  - Sources:
    - <https://supabase.com/docs/guides/auth/server-side/creating-a-client> ("On projects with asymmetric signing keys, the default for new projects, it verifies locally against a cached copy of the project's public keys.")
    - <https://supabase.com/docs/guides/auth/signing-keys> ("the Supabase client libraries may cache the keys in memory for an additional 10 minutes")
    - <https://supabase.com/docs/reference/javascript/auth-getclaims>
    - `GoTrueClient.ts` `getClaims`/`fetchJwk` in `@supabase/auth-js@2.118.0`
  - **Requirement for the data-model/infra agent:** the project must use **asymmetric JWT signing keys** (ES256/RS256). On a legacy HS256 project, every gated request would call Auth.
- **Rejected alternative:** `jose` `jwtVerify` with `createRemoteJWKSet` gives the same result but adds a dependency, and it does not refresh cookies, so the proxy would still need `@supabase/ssr`. Use it only if the proxy should never touch Auth.
- **Defense in depth:** RLS is the real authorization boundary, and the proxy only decides where to route. Admin RPCs re-check `is_admin()` in SQL.

### 1.4 Route table

Legend:
- **Render:** S = static prerender at build. S+C = static shell, with data loaded by client components after hydration. RH = route handler, run per request.
- **Auth:** -- = public. U = signed-in user (proxy). A = admin role (proxy plus RPC check). MFA = AAL2 required (the proxy redirects if factors are enrolled).

| Screen | Path | Layout | Render | Auth | Key components |
|---|---|---|---|---|---|
| Homepage | `/` | (marketing) | S | -- | MarketingNavbar, Hero, BenefitsGrid, SecuritySection, FeaturesSection, LiveMarketPreview (client island), CtaBand, SupportWidget, Footer |
| Legal: terms / privacy / risk | `/legal/*` | (marketing) | S | -- | LegalArticle (MDX or TSX), Footer |
| Sign in | `/sign-in` | (auth) | S | -- (redirects to `/spot` client-side if a session exists) | SignInForm (email+password, passkey button), OAuthDivider (optional) |
| MFA challenge | `/sign-in/mfa` | (auth) | S | session at AAL1 | MfaChallenge (TOTP via InputOTP, phone OTP, passkey) |
| Sign up | `/sign-up` | (auth) | S | -- | SignUpForm (email, password, country, nickname, terms checkbox, VirtualFundsNote) |
| Forgot password | `/forgot-password` | (auth) | S | -- | ResetRequestForm |
| Update password | `/update-password` | (auth) | S | recovery session | UpdatePasswordForm |
| Auth callback | `/auth/callback` | -- | RH | -- | `exchangeCodeForSession` and redirect to `next` |
| Email confirm | `/auth/confirm` | -- | RH | -- | `verifyOtp({ type, token_hash })` and redirect |
| Spot terminal | `/spot?symbol=` | (app) | S+C | U | TerminalLayout, SymbolHeader, MarketList, PriceChart, OrderBook / LatestTrades tabs, SpotOrderForm (Limit/Market tabs, Buy + Sell panels, QtySlider), UserOrdersPanel (Open Orders / Order History / Fills) |
| Forex terminal | `/forex?symbol=` | (app) | S+C | U | TerminalLayout, SymbolHeader, MarketList(forex), DrawingToolbar, PriceChart (timeframes 1m–1M, volume + MA5/10/20, Native/Depth toggle, AureonX watermark), OrderBook + LatestTrades, ForexOrderForm (the Spot form with the forex wallet; see D6), UserOrdersPanel |
| Options terminal | `/options?symbol=` | (app) | S+C | U | TerminalLayout, SymbolHeader, MarketList(options), PriceChart (compact, entry-price line + expiry markers), OptionsTicket (Rise/Fall, CycleSelector, PremiumPresets + custom, fee/expected profit, SlideToConfirm), OptionsPositionsTabs (Positions with ExpiryCountdown, Filled Orders, Statistics) |
| My Assets | `/assets` | (app) | S+C | U | TotalBalanceHeader, SubWalletCards (Capital/Spot/Forex/Options), ProfitChart (1D/1W/1M/6M), AssetTable (per coin), QuickActions (Deposit/Withdraw/Transfer) |
| Deposit crypto | `/assets/deposit/crypto` | (app) | S+C | U (KYC optional, D7) | Stepper: CoinSelect → NetworkSelect → VirtualDepositNotice (no receiving address is shown: this is a virtual-credit request, decisions.md C9) → Amount → Submit; RecentRequestsTable |
| Withdraw crypto | `/assets/withdraw/crypto` | (app) | S+C | U + MFA + KYC approved | Stepper: CoinSelect → NetworkSelect → DestinationAddress → Amount (fee, min, available) → Confirm (TOTP/phone code) ; RecentRequestsTable |
| Deposit fiat | `/assets/deposit/fiat` | (app) | S+C | U | Stepper: Currency → Method (bank transfer, virtual credit) → Amount → Reference shown → Submit |
| Withdraw fiat | `/assets/withdraw/fiat` | (app) | S+C | U + MFA + KYC approved | Stepper: Currency → BeneficiaryForm → Amount → Confirm |
| Transfer | `/assets/transfer` | (app) | S+C | U | TransferForm (From wallet ⇄ To wallet swap button, asset, amount, Max), RecentTransfers |
| Bills | `/assets/bills` | (app) | S+C | U | BillsFilters (wallet, type, asset, date range), BillsTable (keyset pagination), BillDetailSheet |
| Profile | `/account` | (app) | S+C | U | ProfileCard (nickname editable, UID copy, email, phone, country, KycStatusBadge) |
| Security Center | `/account/security` | (app) | S+C | U | SecurityItem rows: Passkeys (list, add, rename, delete), Authenticator app (TOTP enroll QR + verify / unenroll), Phone (enroll MFA phone; needs Supabase's paid Advanced MFA add-on, decisions.md O8), Email verification status, Change password; SecurityScore |
| KYC | `/account/kyc` | (app) | S+C | U | KycStepper: Country → DocType → PersonalInfo → DocumentUpload (front/back) + Selfie → Review & submit; KycStatusPanel (pending/approved/rejected + reason) |
| Admin dashboard | `/admin` | admin | S+C | A + MFA | QueueCountCards (pending deposits, withdrawals, KYC), RecentAuditList |
| Admin users | `/admin/users` (`?id=`) | admin | S+C | A | UsersTable (search, filters, pagination), UserDetailSheet (profile, KYC, wallets, BalanceAdjustDialog credit/debit, orders, bills, ban/unban → D9) |
| Admin deposits | `/admin/deposits` | admin | S+C | A | RequestQueueTable (status tabs), ReviewDialog (approve/reject + note) |
| Admin withdrawals | `/admin/withdrawals` | admin | S+C | A | RequestQueueTable, ReviewDialog |
| Admin KYC | `/admin/kyc` (`?id=`) | admin | S+C | A | KycQueueTable, KycReviewPanel (signed-URL image viewer, approve/reject with reason) |
| Admin options config | `/admin/options-config` | admin | S+C | A | CycleConfigTable (cycle seconds, profit rate, fee rate, min/max premium, enabled), inline edit + save |
| Admin audit | `/admin/audit` | admin | S+C | A | AuditLogTable |
| 404 | any unknown path | root | S | -- | NotFound (logo, back home) |
| Error boundaries | `global-error.tsx`, `(app)/error.tsx`, `admin/error.tsx` | -- | client | -- | ErrorState (retry `reset()`, Sentry event id) |
| Terminal loading | `spot|forex|options/loading.tsx` | (app) | S | -- | TerminalSkeleton |

**Static enforcement:** `cacheComponents` is off in the current `next.config.ts`. Put `export const dynamic = 'error'` in `(marketing)/layout.tsx`, `(auth)/layout.tsx`, `(app)/layout.tsx` and `admin/layout.tsx`, so that an accidental `cookies()` or `headers()` call fails the build instead of silently switching on SSR. Do not put it in `(auth)/auth/*/route.ts`. If `cacheComponents` is turned on later, Next 16.4 adds `export const ensureStatic = 'navigation'` for the same guarantee (<https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config/ensureStatic>, added in v16.4.0). Server components may only render static chrome; everything user-specific is a client component.

**Virtual funds indicator (recommended placement):**
1. A persistent amber `Badge` reading "VIRTUAL FUNDS" in the `AppHeader`, directly left of the total-balance/UserMenu cluster. It is visible on every (app) and admin screen at every width; on mobile it collapses to a "VIRTUAL" pill next to the logo.
2. The same text inside every order confirmation: SlideToConfirm label and order sheet footer.
3. A one-line disclosure in the marketing Footer and on the (auth) cards.

Clicking the badge opens a Popover explaining "Virtual balances credited by an administrator; no real money is involved." The placement avoids a dismissible banner, because a dismissed banner would no longer be persistent.

---

## 2. Shared components (used by all three terminals)

All of these are client components (`'use client'`), lazily mounted under `TerminalLayout`. Props are TypeScript-ish sketches.

| Component | Props sketch | Spot | Forex | Options | Data source |
|---|---|:-:|:-:|:-:|---|
| `TerminalLayout` | `{ kind: 'spot'\|'forex'\|'options'; slots: { header; marketList; chart; book; orderForm; bottom } }`. Renders a CSS grid at md+ and `MobileTerminalTabs` below md | ✓ | ✓ | ✓ | static |
| `SymbolHeader` | `{ symbol: string; onOpenMarkets(): void }`. Shows last, 24h change %, high, low, volume, and a favorite star | ✓ | ✓ | ✓ | market store (ticker); favorite = Supabase RLS read + RPC write |
| `MarketList` | `{ activeSymbol; defaultFilter: 'favorites'\|'spot'\|'forex'\|'options'; onSelect(symbol) ; compact?: boolean }`. Filter tabs, search input, sortable columns (symbol, last, change) with ascending/descending toggle, virtualized rows | ✓ | ✓ | ✓ | instrument list = Supabase RLS read (`instruments`, cached in memory for the session); prices = market store (bulk ticker); favorites = Supabase RLS read |
| `PriceChart` | `{ symbol; timeframes: Timeframe[]; defaultTf; showVolume?: boolean; volumeMAs?: number[] /*[5,10,20]*/; modes?: ('native'\|'depth')[]; watermark?: string /*'AureonX'*/; drawingTools?: boolean; overlays?: { priceLines?: PriceLine[]; markers?: Marker[] }; height? }` | ✓ (tf subset, volume) | ✓ (all features) | ✓ (compact, entry lines) | market store (candles + live ticks) |
| `ChartTimeframeBar` | `{ value: Timeframe; options: Timeframe[]; onChange }`, where `Timeframe = '1m'\|'5m'\|'15m'\|'30m'\|'1h'\|'4h'\|'1D'\|'1W'\|'1M'` | ✓ | ✓ | ✓ | static |
| `ChartModeToggle` | `{ value: 'native'\|'depth'; onChange }` | -- | ✓ | -- | static |
| `DepthChart` | `{ symbol; levels?: number }`. Uses `createOptionsChart` (price on the horizontal axis, LWC ≥5.1) with two `AreaSeries` (cumulative bids green, asks red) | -- | ✓ | -- | market store (order book) |
| `DrawingToolbar` | `{ chartApi: IChartApi; series: ISeriesApi; tools: DrawingTool[]; onChange(drawings) }` where `DrawingTool = 'cursor'\|'trendline'\|'hline'\|'vline'\|'rect'\|'fib'\|'text'\|'clear'` | -- | ✓ | -- | static; drawings persisted per user in `localStorage` (D5) |
| `OrderBook` | `{ symbol; depth?: 10\|20\|50; grouping?: number; onPriceClick?(price) }`. Columns are price, qty and total; red asks on top, green bids below, a spread/mid row, and a depth bar per row | ✓ | ✓ | -- | market store (order book) |
| `LatestTrades` | `{ symbol; limit?: number }`. Columns are time, price (colored by side) and qty | ✓ | ✓ | ✓ (optional tab) | market store (trades) |
| `BookTradesTabs` | `{ symbol }`. Tabs: Order Book / Latest Trades | ✓ | ✓ (side by side at xl) | -- | -- |
| `OrderTypeTabs` | `{ value: 'limit'\|'market'; onChange }` | ✓ | ✓ | -- | static |
| `OrderSidePanel` | `{ side: 'buy'\|'sell'; type; symbol; base; quote; available: Decimal; lastPrice; onSubmit(PlaceOrderInput) }`. Contains PriceInput (limit only), QtyInput, QtySlider, Total, and a Submit button colored by side | ✓ (×2 side-by-side) | ✓ | -- | available = Supabase RLS read + Realtime; submit = Supabase RPC `place_spot_order` / `place_forex_order` |
| `QtySlider` | `{ value: 0..100; onChange; marks: [0,25,50,75,100] }`. Wraps the shadcn `slider` with step 1 and snap marks | ✓ | ✓ | -- | static |
| `DecimalInput` | `{ value: string; onChange; precision; step; suffix; min?; max? }` (string-based to avoid float error) | ✓ | ✓ | ✓ | static |
| `UserOrdersPanel` | `{ kind: 'spot'\|'forex'; symbol?: string; tabs: ('open'\|'history'\|'fills')[] }`. Includes a cancel button (RPC `cancel_order`) | ✓ | ✓ | -- | Supabase RLS read + Realtime; cancel = RPC |
| `OptionsTicket` | `{ symbol; cycles: CycleConfig[]; balance: Decimal; onPlaced(order) }` | -- | -- | ✓ | cycles = Supabase RLS read (`option_cycles`); balance = RLS read + Realtime; submit = RPC `place_option_order` |
| `CycleSelector` | `{ cycles: CycleConfig[] /* {seconds, profit_rate, fee_rate, min_premium, max_premium} */; value; onChange }` | -- | -- | ✓ | Supabase RLS read |
| `PremiumPicker` | `{ presets: number[]; value; min; max; onChange }`. Preset chips plus a custom amount | -- | -- | ✓ | static (presets) + cycle limits |
| `SlideToConfirm` | `{ label; disabled?; tone: 'up'\|'down'; onConfirm(): Promise<void> }`. Built on Motion `drag="x"` with keyboard fallback (Enter/Space ⇒ confirm dialog) | -- | -- | ✓ | static |
| `ExpiryCountdown` | `{ expiresAt: string /*server ISO*/; serverOffsetMs: number }`. Computes `remaining = expiresAt − (Date.now() + serverOffsetMs)`, ticks with `requestAnimationFrame`/1 s interval, renders "Settling…" at ≤0 until a Realtime update arrives | -- | -- | ✓ | derived from Supabase row + `server_time()` offset |
| `OptionsPositionsTabs` | `{ symbol? }`. Tabs: Positions (open, with countdown and live P/L vs entry), Filled Orders (settled), Statistics (win rate, total premium, net P/L by cycle) | -- | -- | ✓ | Supabase RLS read + Realtime; stats = RLS read of view/RPC `options_stats` |
| `PositionsTable` (generic) | `{ columns: ColumnDef<T>[]; rows: T[]; loading; empty; onRowAction? }`. Built on TanStack Table and the shadcn `table` | ✓ | ✓ | ✓ | caller supplies |
| `MobileTerminalTabs` | `{ tabs: { id: 'chart'\|'book'\|'trades'\|'order'\|'positions'; label; content }[] }` | ✓ | ✓ | ✓ | static |
| `OrderSheet` (mobile) | `{ open; side; onOpenChange; children }`. Wraps the shadcn `drawer` (vaul) as a bottom sheet | ✓ | ✓ | ✓ | static |
| `ConnectionStatus` | `{}`. A small dot showing market-feed and Realtime state (live / reconnecting / stale) | ✓ | ✓ | ✓ | market store status + Realtime channel status |

**Server-time offset (options countdown):** the options terminal calls RPC `server_time()` once on mount, measuring the round-trip time (RTT), and stores `serverOffsetMs = serverNow − (clientSendTime + rtt/2)`. `place_option_order` must return `opened_at`, `expires_at` and `server_now`, and the offset is refreshed from that `server_now`. The countdown is never started from a client timestamp. When the countdown reaches zero the UI shows "Settling…". Only the Realtime row update with `status ∈ {won, lost, draw}` and `settle_price` changes the result.

---

## 3. shadcn/ui primitives

These are the component names as the shadcn CLI registry spells them (verified against `shadcn-ui/ui` `apps/v4/registry/new-york-v4/ui` on 2026-10-25). Use the **Radix** base (`radix-ui` package); the CLI also offers `base` (Base UI) and `aria`.

```
pnpm dlx shadcn@latest add \
  accordion alert alert-dialog avatar badge breadcrumb button button-group card chart checkbox \
  collapsible command dialog drawer dropdown-menu empty field form hover-card input input-group \
  input-otp item kbd label navigation-menu pagination popover progress radio-group resizable \
  scroll-area select separator sheet sidebar skeleton slider sonner spinner switch table tabs \
  textarea toggle toggle-group tooltip
```

Where each one is used:

| Primitive | Used for |
|---|---|
| `navigation-menu` | Marketing navbar; app top nav with the "Asset Management" dropdown at ≥1280 |
| `dropdown-menu` | Asset Management dropdown (≤1279), UserMenu, table row actions |
| `sheet` | Mobile nav drawer, MarketList drawer on mobile, admin detail panels, BillDetailSheet |
| `drawer` | Mobile bottom-sheet order form (vaul) |
| `tabs` | Limit/Market, Book/Trades, terminal bottom panels, Positions/Filled/Statistics, admin status tabs |
| `toggle-group` | Timeframe bar, Native/Depth toggle, profit-chart ranges, MarketList filters, premium presets |
| `slider` | Quantity 0–100% |
| `resizable` | Desktop terminal panes (chart/book split) at ≥1280 |
| `scroll-area` | Order book, trades, market list |
| `table` | All tables (combined with `@tanstack/react-table`) |
| `chart` | Assets profit chart and admin stats (Recharts-based; client-only). Not used for candlesticks |
| `form` + `field` + `input` + `input-group` + `label` + `select` + `textarea` + `checkbox` + `radio-group` + `switch` | All forms (react-hook-form + zod) |
| `input-otp` | TOTP / phone code entry |
| `command` + `popover` | Coin/network searchable pickers, MarketList search |
| `dialog` / `alert-dialog` | Order confirm (spot), approve/reject, unenroll factor, balance adjust |
| `card`, `badge`, `avatar`, `separator`, `skeleton`, `spinner`, `empty`, `item`, `kbd`, `progress`, `tooltip`, `hover-card`, `breadcrumb`, `pagination`, `alert`, `accordion`, `collapsible`, `button`, `button-group` | General UI (`progress` for the KYC stepper and upload progress; `accordion` for FAQ/Security sections) |
| `sidebar` | Admin shell |
| `sonner` | Toasts (order placed/filled, request status changes) |

Non-shadcn pieces to build: `Stepper` (KYC, deposit and withdraw flows, built on `progress` + `item`), `SlideToConfirm`, `QrCode` (`qrcode` lib, client-only), and `FileDropzone` (native input + drag/drop; no extra lib).

---

## 4. Responsive behavior

**Mobile first (C20).** The primary viewport is 390–430 px, and desktop is secondary. Every screen is designed and built at **390 px first**. Its 390 px column is the base layout, and the 768 px and 1280 px columns are enhancements layered on with `md:` / `xl:` utilities. Unprefixed Tailwind classes always describe the phone layout.

Breakpoints follow Tailwind defaults: `sm` 640, `md` 768, `lg` 1024, `xl` 1280.

**Bottom padding rule:** every scrollable page reserves bottom padding equal to the tab bar height plus `env(safe-area-inset-bottom)`, so the last row is never hidden behind the tab bar or the home indicator.

**Phone review gate:** each UI slice ends with a review on a real phone (390–430 px, iOS Safari and Android Chrome) before sign-off. A desktop browser's device emulation does not count.

### 4.1 Spot terminal

| 390 px (base) | 768 px (enhancement) | 1280 px (enhancement) |
|---|---|---|
| Header: logo, "VIRTUAL" pill, hamburger (Sheet). `SymbolHeader` is one row: symbol (tap ⇒ MarketList Sheet from left), last price, change %. **MobileTerminalTabs** (sticky under the header): **Chart / Book / Trades / Orders**. Chart tab: chart at 55vh with the timeframe bar scrolling horizontally. Book tab: 12 asks / spread / 12 bids, with grouping select. A sticky bottom bar holds two full-width buttons, **Buy** (green) and **Sell** (red), which open an **OrderSheet** (Drawer, ~85vh) with Limit/Market tabs, one side panel for the chosen side, a side switch at the top, the slider and submit. Orders tab: open orders as cards, not a table. | Two columns. Left (≈62%): SymbolHeader, Chart (420 px) and, beneath it, Tabs Book/Trades (book 10 + 10). Right (≈38%): the order form with Buy/Sell **stacked as tabs** (not side-by-side) and Limit/Market. Below both, full width: UserOrdersPanel. MarketList is a Sheet opened from SymbolHeader. | Three-pane grid: **MarketList (280 px)** · **Chart (flex)** · **OrderBook/LatestTrades tabs (320 px)**. Under chart and book is the order form with **Buy and Sell panels side by side**, Limit/Market tabs above them. Under the market list is space for favorites/recent. Full-width UserOrdersPanel at the bottom. Panes are `resizable` and the layout is saved in localStorage. |

### 4.2 Forex terminal

| 390 px (base) | 768 px (enhancement) | 1280 px (enhancement) |
|---|---|---|
| Same tab model: **Chart / Book / Trades / Order**. The DrawingToolbar collapses into a single "✎" button that opens a horizontal tool strip over the chart's top edge. Drawing needs tap-tap placement; long-press shows a magnifier only if time allows. Volume pane and MA legend stay, at 20% of chart height. Native/Depth toggle sits in the chart header. Watermark font scales to 28 px. Order via bottom-sheet. | Chart full width (480 px) with a vertical DrawingToolbar (40 px) on the left. Below it, Book and Trades **side by side** (50/50), then the order form. | **DrawingToolbar (44 px, left)** · **Chart (flex; volume pane with MA5/10/20; tf bar 1m…1M; Native/Depth)** · **right column 340 px: OrderBook on top (60%), LatestTrades below (40%)**. Order form and positions sit under the chart. MarketList is a collapsible left drawer with forex pairs (XAU/USD, EUR/USD, AUD/USD, AUD/JPY, AUD/CAD, CAD/JPY …). |

### 4.3 Options terminal

| 390 px (base) | 768 px (enhancement) | 1280 px (enhancement) |
|---|---|---|
| Tabs: **Chart / Trade / Positions**. Trade tab: "I expect **BTC/USDT** will…" headline; two large buttons, **Rise ▲** (green) and **Fall ▼** (red), each 50% wide and 56 px tall. A horizontally scrolling cycle chip row (30s 60s 90s 120s 300s, each with "+85%" from the DB). Premium preset chips and a custom input. Fee and expected profit live. **SlideToConfirm** is full width and pinned to the bottom (safe-area aware). Positions tab: cards with a big countdown. | Chart (60% width) and Ticket (40%) side by side. Positions tabs full width below. | MarketList (260) · Chart (flex, with entry-price lines and expiry vertical markers for open positions) · **Ticket (360)**. Positions / Filled Orders / Statistics tabs full width below. |

### 4.4 Assets (all asset pages)

| 390 px (base) | 768 px (enhancement) | 1280 px (enhancement) |
|---|---|---|
| TotalBalanceHeader (amount in USDT-equivalent, eye toggle to hide amounts, "VIRTUAL"). Sub-wallets are a **horizontal snap carousel** of 4 cards. Quick actions are a 3-icon row (Deposit / Withdraw / Transfer). Profit chart at 180 px with the 1D/1W/1M/6M toggle. The asset table becomes a card list. Steppers show one step per screen with a "Step 2 of 4" header and Back/Next in a sticky footer. Bills render as list items; tapping one opens a bottom drawer with the detail. | Sub-wallet cards in a 2×2 grid. Profit chart full width at 240 px. Tables use horizontal scroll with a sticky first column. Steppers show a horizontal step indicator above a single form column. | Header plus a 4-card row. Two columns: profit chart (2/3) and allocation/donut chart or quick actions (1/3). Full table below. Deposit/withdraw use a vertical stepper at left (240 px) with a form at right and a "Recent requests" table under it. Transfer is a centered 480 px card. |

### 4.5 Account and KYC
- 390: single column. Security items are a vertical list of rows (icon, title, status badge, chevron), and each opens a full-screen Sheet. Camera capture for the selfie uses `<input type="file" accept="image/*" capture="user">`.
- 768: two-column form grid. Security rows use inline buttons.
- 1280: a left sub-nav (Profile / Security / KYC, 220 px) and a content column with a max width of 880 px.

### 4.6 Admin

| 390 px (base) | 768 px (enhancement) | 1280 px (enhancement) |
|---|---|---|
| Supported but secondary. The sidebar becomes an off-canvas Sheet. Queue tables become cards (user, amount, status, Approve/Reject buttons). The detail view is a full-screen Sheet. KYC images stack vertically with pinch-zoom (native). | Collapsed icon sidebar (56 px). Tables scroll horizontally. Detail is a right Sheet at 90% width. | Full sidebar (240 px). Tables use sticky headers and a filter bar. Detail is a right Sheet (640 px) or a split view. The KYC review shows the document and selfie side by side with the personal data. |

### 4.7 Homepage

| 390 px (base) | 768 px (enhancement) | 1280 px (enhancement) |
|---|---|---|
| Navbar: logo, "Sign in" ghost button, hamburger Sheet holding the nav links. Hero is a single column: H1 at 36 px, subcopy, two stacked CTAs (Get started / Explore markets), and an illustration below. Benefits and Features are single-column cards. LiveMarketPreview shows the top 5 symbols as a compact list (symbol, last, change). Footer link groups become an accordion. The SupportWidget FAB sits bottom-right at 56 px, offset by the safe area. | Hero in two columns (text / illustration). Benefits in a 2×2 grid. LiveMarketPreview as a table of 8 rows. Footer in 3 columns. | Hero with a 56 px H1 and a side visual. Benefits in 4 columns; Security uses alternating rows. LiveMarketPreview shows a tabbed table (Spot / Forex / Options, 10 rows) with sparklines. CTA band. Footer in 5 columns, with the legal disclosure and chart-library attribution line. |

Motion: use `motion/react` with `LazyMotion` + `domAnimation` and the `m.*` components on marketing sections, for scroll-reveal and hero entrance. Respect `prefers-reduced-motion` (`useReducedMotion`). Terminals use **no** Motion animations except SlideToConfirm and Drawer; price flashes are CSS transitions.

---

### 4.8 App shell, Home and Options (mobile-first, from owner reference screens)

**Evidence levels** (used to tag every screen below and in §1.4):
- **Captured:** the owner supplied a reference screenshot; the layout follows it, with AureonX branding only.
- **Described:** specified in the brief's text only; the layout is our interpretation.
- **Designed:** neither; we designed it.

Reference-only elements are **never copied**: the reference logo, the mascot/robot illustration, the colors' exact values, and its practice-account shortcut tile (wording rule).

#### App shell: Captured
- **Bottom tab bar** (fixed, 5 slots): Home · Market · **Trade** (centre, raised round button with a swap icon) · Options · Assets. Active tab is `primary` (brand green) with a label; the others are muted. Height 56 px + `env(safe-area-inset-bottom)`.
- **Trade** destination: O24.
- **Top bar (Home only):** avatar (→ /account) · symbol search pill (→ market search sheet) · language globe · notifications bell · support headset.
- Dark theme by default.

#### Shell palette
Dark only. The shell uses the shadcn tokens: `background` `#050505`, `card` and `popover` `#121212`, `border` `#262626`, `foreground` `#F5F5F5`, `muted-foreground` `#A3A3A3` and `primary` brand green `#1BA04A` with black text. Up and down amounts use the `up` (`#3DD68C`) and `down` (`#F0505A`) tokens. Roles, contrast and usage rules: `docs/brand.md`.

#### Home (`/home`, signed in; the public homepage stays at `/`, slice 9): Captured
1. Top bar as above.
2. **Total asset value** with an eye toggle (hide amounts); large figure plus `USD`. Source: wallets (RLS) valued with the store's prices.
3. **Shortcut grid**, 4 × 2 round icons: Deposit · Options · Forex · Perpetual / Spot · Transfer · Support · (8th slot: Bills). Forex and Perpetual show a "coming soon" state while deferred (O21).
4. **Market table** with tabs Favorites · Popular · Gainers · Losers, plus a category select (Spot / Options / …). Columns: Symbol (with icon, display name per O22, and last-update time) · Sell · Buy (O23) · Change % (green/red).
5. Bottom tab bar; the list reserves the bottom padding.

#### Options (`/options`): Captured
1. **Header:** market-switch icon · symbol (display name, O22) with an info icon · chart-type icon.
2. **Timeframe row:** 1M 5M 15M 30M 1H 4H More▾.
3. **Candlestick chart** with a price axis, high/low markers and a dashed last-price line with a label.
4. "{SYMBOL} Current price {price}" (store price, display only).
5. "I expect {SYMBOL} will **Rise**/**Fall**" with a large green up button and a red down button; the selected side tints the word.
6. **Option period(s)** stepped slider: 30 · 60 · 90 · 120 · 300 s; **PnL n%** on the right = `option_periods.profit_rate_bps` for the chosen period.
7. **Premium Amount (USD)**, available Options-wallet balance and a transfer icon (→ Transfer); preset chips (UI only) and a numeric input; minimum `option_periods.min_premium_cents`.
8. **Transaction fee n%** (`option_periods.fee_bps`) and **Est. return** computed live from the input.
9. Full-width primary button (label per side), then `open_option`.
10. **Positions (n)** · **Filled** tabs, with a stats icon and a "Current instrument only" checkbox.

Slice 5 Part B as built (`/options`, directly in `(app)` like Spot; captured layout, these are the assumptions):
- **Put:** the Fall side was never captured. One plain full-width button on every layout: **Call** (up colour) for Rise, **Put** (dark red, `down` at 80%) for Fall. The enum stays `rise`/`fall`.
- **Symbol list:** the `options_enabled` markets (BTC, ETH, SOL) by `display_symbol`, in a bottom sheet; no prices or search. The choice is not remembered.
- **Info sheet:** each enabled period with its profit rate, the fee rate (first enabled period's `fee_bps`) and one line on settlement and the 90 s refund.
- **Statistics icon:** captured next to the Positions/Fill tabs, not built (hidden).
- **Floating support:** a brand-green headset button (→ `/support`, like the top bar) bottom right, 12 px above the tab bar, on Options and Spot. It fades out while an element marked `data-fab-avoid` (the Call/Put and Spot confirm buttons, the fee/return row) passes under it. These pages pad the bottom by tab bar + 5rem + safe area so the last row clears it.
- **Desktop:** Spot's approach: from `md:` the chart and the ticket sit side by side (ticket 340 px), Positions/Fill full width below; with the chart hidden the ticket is centred at 480 px. No three-column terminal.
- **Current price:** the browser ticker's bid/ask mid at `price_decimals`, display only; `--` without a valid bid and ask. Its colour follows the selected direction.
- **Periods:** the slider has a stop per `option_periods` row in duration order; disabled stops are greyed and cannot be selected. Premium chips are UI only; the input takes up to two decimals; "Est. return" is premium × rate only, the fee is shown beside it with its amount.

### 4.9 Evidence tags for the other screens
| Screen | Evidence |
|---|---|
| Spot, Forex terminals; Assets; Bills; Transfer; Deposit/Withdraw; Account; Security Center; KYC; Admin; public homepage | Described |
| Auth pages, error/404 pages, Market tab list, notifications, support placeholder | Designed |

**Assumptions** for every Described or Designed screen:
- Same dark theme, bottom tab bar and top-bar patterns as the Captured screens.
- 390 px layouts follow §4.1–4.7; any owner screenshot that arrives later replaces them.
- Copy follows `messages/en.json` and the wording rule.
- Market tab = the full-screen version of the Home market table with search.

### 4.10 Slice 2 screens as shipped (evidence tags and assumptions)

| Screen | Path | Evidence |
|---|---|---|
| App shell (top bar, bottom tab bar) | every (app) page | Captured |
| Public root (placeholder; sends signed-in visitors to `/home`) | `/` | Designed |
| Home (total, hide-eye, quick actions) | `/home` | Captured (the market table is in §4.11) |
| Assets hub | `/assets` | Described |
| Transfer | `/assets/transfer` | Designed |
| Bills | `/assets/bills` | Designed |
| Admin (user list + credit/debit) | `/admin` | Designed |
| "Coming soon" placeholders | `/support`, `/notifications` (`/market` became the Market tab in slice 3, `/spot` the Spot terminal in slice 4 (§4.12), `/options` the Options screen in slice 5 (§4.8)) | Designed |

Assumptions (Described and Designed screens, plus choices inside the Captured ones):
- **Shell:** the top bar comes from the `(app)/(with-top-bar)` group layout; every slice 2 page sits in that group, not only Home, so the avatar and the VIRTUAL pill are always one tap away. Inner pages add a back-arrow title row. The language globe is disabled (English only). Search, bell and support open "Coming soon" screens. The raised Trade button has a "Trade" label under it, aligned with the other tab labels. The active tab and the Home quick-action icons use `primary`; up/down amounts use the `up` and `down` tokens. The search pill reads "Search symbol". Trade opens `/spot` (O24 ★), the Spot terminal since slice 4. Full-screen trading screens can live directly in `(app)` to skip the top bar while keeping the tab bar.
- **Theme:** dark for the whole app (the `dark` class on `<html>`), auth pages included.
- **Money display:** every amount is integer cents read with `::text` and formatted with BigInt (`src/lib/money.ts`). Amounts are labelled USD (owner decision; wallets hold USDT treated 1:1 as USD).
- **Home:** total = available + frozen across the 4 wallets. The hide-eye state is not remembered across visits. Only Transfer and Bills tiles are live; the other 6 show a "Soon" badge and are not links. The avatar is a generic icon (no extra profile fetch).
- **Assets:** one card per wallet in fixed order (Capital, Spot, Forex, Options) with available and, when non-zero, frozen. No profit chart (slice 5).
- **Transfer:** native selects. Choosing the other side's wallet swaps the two, and the To list never offers the From wallet. MAX fills the full available balance. One idempotency key per confirm attempt (`crypto.randomUUID()`); a retry after a failure the server never answered reuses it, any answered result or changed input gets a new one. The button is disabled while the request is in flight.
- **Bills:** cards with type, description, signed amount, wallet and local date/time. Filter chips: All and the 4 wallets. Keyset pagination on `(created_at, id)`, 20 per page, with a "Load more" button. Transfer text comes from `en.json` (`counter_account`); admin rows show the DB text "Balance adjustment". Only the signed-in user's own rows, even for an admin.
- **Admin:** the page gate reads the `user_role` and `aal` claims. Not admin: a short notice. Admin at aal1 with a TOTP factor: a step-up prompt to `/sign-in/mfa?next=/admin`; without a factor: a link to Security. Search by email substring or exact 8-digit UID; newest 50 users. The form takes wallet, Credit/Debit, amount and a reason (3 to 200 characters, kept in the audit log only). The proxy does not check the role: RLS and the RPC are the boundary.
- **Proxy matcher:** `/home`, `/account/*`, `/assets/*`, `/admin/*`, `/market`, `/spot`, `/options`, `/support`, `/notifications`. `/` is public and static, outside the proxy; a client check of the local session sends signed-in visitors to `/home`. Sign-in lands on `/home`.

## 5. Data sources per component

Allowed values: **static** · **browser → public exchange API** · **browser → shared cached Worker route** · **browser → Supabase (RLS read)** · **Supabase Realtime** · **Supabase RPC (write)** · **server action (secret: …)**.

"Market store" means the market-data agent's provider. Whether a given feed reaches the store from *browser → public exchange API* or from *browser → shared cached Worker route* is the market-data agent's call; the expected split is in the table, flagged with ⚑.

### 5.1 Marketing, auth and shell

| Component | Data source |
|---|---|
| MarketingNavbar, Hero, BenefitsGrid, SecuritySection, FeaturesSection, CtaBand, Footer, Legal pages, NotFound | static |
| LiveMarketPreview | browser → shared cached Worker route ⚑ (one `GET /md/v1/tickers?set=home`, edge-cached a few seconds; the store's bulk ticker; optionally a public exchange WS after first paint) |
| SupportWidget (placeholder) | static (opens a Sheet with a contact email / "coming soon"; no third-party script in v1) |
| "Signed in?" CTA swap on the homepage | browser → Supabase (local session read from cookie storage via `getSession()`, no network) |
| SignInForm / SignUpForm / ResetRequestForm / UpdatePasswordForm | Supabase Auth client (`signInWithPassword`, `signUp`, `resetPasswordForEmail`, `updateUser`). Counts as **Supabase RPC (write)** class: a browser call to Supabase |
| Passkey sign-in button | Supabase Auth client `signInWithPasskey()` (experimental opt-in; see D4) |
| MfaChallenge | Supabase Auth client `mfa.challenge`/`mfa.verify` (write) |
| `/auth/callback`, `/auth/confirm` | route handler (no secret; uses the publishable key + cookies) |
| AppHeader balance pill, VirtualFundsBadge | browser → Supabase (RLS read `wallets`) + Supabase Realtime |
| UserMenu (nickname, avatar, KYC badge) | browser → Supabase (RLS read `profiles`) |

### 5.2 Terminals

| Component | Data source |
|---|---|
| MarketList: instrument metadata | browser → Supabase (RLS read `instruments`, public-readable) |
| MarketList: prices, change | market store ⚑ (crypto spot: browser → public exchange API (WS/REST); forex/metals: browser → shared cached Worker route) |
| MarketList: favorites | browser → Supabase (RLS read `favorites`); toggle = Supabase RPC `toggle_favorite` |
| SymbolHeader ticker | market store ⚑ |
| PriceChart history candles | market store ⚑ (crypto: public exchange REST klines; forex: shared cached Worker route `/md/v1/candles?symbol&tf`, edge-cached per (symbol, tf, bucket)) |
| PriceChart live updates | market store ⚑ (crypto: public WS; forex: the store derives candle updates from ticker polling **of the Worker route at the store level, once per symbol across all components and tabs**. This is a market-data refresh, not polling of user data) |
| Volume + MA5/10/20 | derived client-side from candles (static computation) |
| DepthChart | market store order book ⚑ |
| DrawingToolbar drawings | static + localStorage (per user/symbol; D5 covers DB persistence) |
| AureonX watermark | static |
| OrderBook, LatestTrades | market store ⚑ (crypto: public exchange WS depth/trades; forex: synthetic book from the Worker route, see conflicts) |
| OrderSidePanel available balance | browser → Supabase (RLS read `wallets`) + Supabase Realtime |
| Place spot/forex order | Supabase RPC (write) `place_spot_order` / `place_forex_order` |
| Cancel order | Supabase RPC (write) `cancel_order` |
| UserOrdersPanel | browser → Supabase (RLS read `orders`, `fills`) + Supabase Realtime |
| OptionsTicket cycles/profit rates | browser → Supabase (RLS read `option_cycles`, public-readable) + Supabase Realtime (admin changes) |
| Server time offset | Supabase RPC `server_time()` (read-only RPC) |
| Place option | Supabase RPC (write) `place_option_order` |
| OptionsPositionsTabs: Positions / Filled | browser → Supabase (RLS read `option_orders`) + Supabase Realtime |
| Statistics | browser → Supabase (RLS read view `option_stats_v` or RPC `get_option_stats`) |
| ConnectionStatus | market store status + Realtime channel status (static logic) |

### 5.3 Assets, account and admin

| Component | Data source |
|---|---|
| TotalBalanceHeader, SubWalletCards, AssetTable | browser → Supabase (RLS read `wallets`) + Supabase Realtime; USD valuation = balances × market store tickers (client) ⚑ |
| ProfitChart 1D/1W/1M/6M | browser → Supabase (RLS read `portfolio_snapshots`, written by a DB cron) |
| TransferForm | Supabase RPC (write) `transfer_between_wallets` |
| Deposit/withdraw: coin & network lists, platform deposit address, fees, mins | browser → Supabase (RLS read `asset_networks`, public-readable) |
| Create deposit / withdrawal request | Supabase RPC (write) `create_deposit_request` / `create_withdrawal_request` / `cancel_withdrawal_request` |
| Recent requests tables | browser → Supabase (RLS read) + Supabase Realtime (status changes on approval) |
| BillsTable | browser → Supabase (RLS read `ledger_entries`, keyset pagination on `(created_at, id)`) |
| ProfileCard | browser → Supabase (RLS read `profiles`); edit nickname = Supabase RPC `update_profile` |
| Security: TOTP / phone factor enroll, verify, unenroll | Supabase Auth client `mfa.enroll` / `mfa.challenge` / `mfa.verify` / `mfa.unenroll` (browser → Supabase) |
| Security: passkeys list/add/rename/delete | Supabase Auth client `auth.passkey.*` / `registerPasskey()` (D4). **If D4 picks the self-hosted path: server action (secret: `SUPABASE_SECRET_KEY` + a WebAuthn challenge-signing secret).** |
| Security: change password / email | Supabase Auth client `updateUser` (reauthentication nonce if "secure password change" is on) |
| KycStepper: text fields | Supabase RPC (write) `submit_kyc` |
| KycStepper: document + selfie upload | browser → Supabase Storage (direct `upload()` to private bucket `kyc/{uid}/…`, Storage RLS insert-own-folder). **Not** through a server action (1 MB default `serverActions.bodySizeLimit`, and it would waste Worker CPU) |
| KycStatusPanel | browser → Supabase (RLS read `kyc_submissions`) + Supabase Realtime |
| Admin tables (users, queues, audit) | browser → Supabase (RLS read; admin policies via `private.is_admin()` reading `user_roles`) + Supabase Realtime (new pending items) |
| Admin approve/reject, credit/debit, cycle config | Supabase RPC (write) `admin_review_deposit`, `admin_review_withdrawal`, `admin_review_kyc`, `admin_adjust_balance`, `admin_upsert_option_cycle` (SECURITY DEFINER + `is_admin()` check + audit row) |
| Admin KYC image viewer | browser → Supabase Storage `createSignedUrl` (Storage RLS select policy for admins; 60 s URLs) |
| Admin ban/unban, reset a user's MFA, force sign-out | **server action (secret: `SUPABASE_SECRET_KEY` for `auth.admin.*`)**. These are the only admin operations Postgres RLS cannot do (D9) |
| Admin user email/phone in the list | browser → Supabase (RLS read `profiles`, which mirrors email/phone from `auth.users` via trigger), so no secret is needed for listing |

### 5.4 Server-side code inventory (complete)
1. `proxy.ts` (or `middleware.ts`): JWT verification and cookie refresh on protected paths only. No secret; uses the publishable key.
2. `/auth/callback` and `/auth/confirm` route handlers. No secret.
3. Server actions in `src/app/admin/_actions.ts`: `banUser`, `unbanUser`, `resetUserMfa`, `signOutUser`. Secret: `SUPABASE_SECRET_KEY`. Each action re-verifies `getClaims()` admin role and AAL2 before acting.
4. *(Only if D4 = self-hosted WebAuthn)* `src/app/account/security/_passkey-actions.ts`.
5. The shared market-data Worker route `/md/v1/*` belongs to the market-data agent. The UI consumes it only through the store.

### 5.5 Explicit confirmation: no Next route is polled
**No UI component polls a Next.js route.**
- User data (balances, orders, positions, requests, KYC, admin queues) is read once from Supabase and then kept fresh by Supabase Realtime. No `setInterval` + `fetch('/api/...')` exists for user data.
- Realtime channel names are `user:${uid}:wallets:${crypto.randomUUID()}` and similar. They are created in `useEffect`, and the cleanup calls `supabase.removeChannel(ch)`.
- The only repeated network activity against the Worker is the market-data store's refresh of the **shared, edge-cached** forex/metals endpoint, owned by the market-data agent. It has one timer per symbol per browser (leader tab via `BroadcastChannel`), it is not per component, and it is served from Workers Cache in front of the market-data Worker: hits run no Worker code but are still billed as Worker requests (`docs/market-data.md` §5; Cache Rules cannot sit in front of a Worker). Page visibility pauses it (`document.visibilityState`).
- Countdown timers are local `requestAnimationFrame`/interval renders against `expires_at`; they make no network calls.

---

## 6. OpenNext on Workers: compatibility of every Next.js feature the spec uses

Sources: OpenNext Cloudflare docs <https://opennext.js.org/cloudflare> (repo `opennextjs/docs`, `pages/cloudflare/index.mdx`, `caching.mdx`, `howtos/image.mdx`, `troubleshooting.mdx`), the adapter changelog <https://github.com/opennextjs/opennextjs-cloudflare/blob/main/packages/cloudflare/CHANGELOG.md> (1.20.13, 2026-10-21), and the Next.js 16.4 docs bundled at `node_modules/next/dist/docs`.

| Feature | Status on `@opennextjs/cloudflare@1.20.x` | Plan / replacement |
|---|---|---|
| Next.js version | Docs: "All minor and patch versions of Next.js 16 and the latest minors of Next.js 14 and 15 are supported". The peer range is `>=16.4.1`, and 1.20.12 adds "support for Next.js 16.4". The adapter raised its floor because of CVE-2026-94545 (`next/og` RCE in 16.2.0–16.3.5). | **Next 16.4.3** (matches the scaffold). Keep patch-current. |
| App Router, route groups, dynamic routes, route handlers | ✅ | Used. |
| SSG (static prerender) | ✅. Prerendered HTML/RSC is served through the incremental cache | `staticAssetsIncrementalCache` (read-only, Workers Static Assets). Already configured in `open-next.config.ts`; no R2/KV/D1/DO bindings. |
| ISR / `revalidate` / `revalidateTag` / `revalidatePath` | ✅ but needs an R2 incremental cache, plus a DO Queue for time-based revalidation and a D1/DO tag cache for on-demand revalidation (`caching.mdx`). With the static-assets cache: "Revalidation is not supported with this cache." | **Avoid.** No `export const revalidate`, no `fetch(..., { next: { revalidate } })`, and no `revalidatePath`. Content changes ship by redeploy; live data is fetched client-side. |
| `'use cache'` / `cacheComponents` / PPR | ✅ per the docs (PPR, composable caching). Cache interception "does not work with PPR". `use cache` lifetimes imply a writable cache. | Keep `cacheComponents` **off** (current config). Static pages + client data make PPR unnecessary. If turned on later, use `ensureStatic` and only `cacheLife('max')`-style build-time caches. |
| Edge runtime (`export const runtime = 'edge'`) | ❌. Docs: "your app should use the Node.js runtime"; get-started step: "Remove any `export const runtime = "edge";`". Next 16 also marks `edge` deprecated. | **Never export `runtime`.** Default nodejs only. Add an ESLint `no-restricted-syntax` rule for `runtime = 'edge'`. |
| Middleware / Proxy | Next 16 renamed `middleware.ts` → `proxy.ts`; "Proxy defaults to using the Node.js runtime … not configurable". "If you want to continue using the `edge` runtime, keep using `middleware`" (Next 16 upgrade guide). OpenNext: edge middleware ✅ stable. Node middleware (`proxy.ts`) has been supported since **1.20.3 (#1309), marked "experimental" and requiring `nodejs_compat`**. The docs index still says "Node Middleware … not yet supported" (stale). Related fixes: instrumentation dynamic-require stub (#1359) and not bundling `@vercel/og` into the Node middleware (#1437, 1.20.11). | See **D2**. Recommended: start with **`proxy.ts`** to follow Next 16 and the current Supabase docs, and run a smoke test (`opennextjs-cloudflare preview`) on day 1. If it fails, fall back to `middleware.ts` (edge, deprecated but supported), which has identical code. Keep the matcher protected-only. |
| `next/image` | Optimization needs a Cloudflare Images binding or a custom loader, and "can incur additional costs". | `images: { unoptimized: true }` (already set). Ship pre-sized WebP/AVIF/SVG in `/public`. |
| `next/font` (Google or local) | ✅. Fonts are downloaded at build and served as static assets | Use `next/font/google` (e.g. Inter + JetBrains Mono for numbers) or `next/font/local`. No runtime cost. |
| `next/og` / `opengraph-image.tsx` / `ImageResponse` | Works, but bundles `@vercel/og` + `resvg.wasm` (~1.4 MiB per changelog #1221; "~500kB" saved when unused, #1076). There is also an RCE CVE in 16.2–16.3.5. | **Do not use.** Ship static `public/og.png` and set `metadata.openGraph.images` statically. This keeps 1–1.5 MiB out of the 10 MiB budget. |
| Server Actions | ✅. Default body limit is **1 MB** (`serverActions.bodySizeLimit`). 1.20.13 fixed action redirects to use the request host. | Only the few secret-holding admin actions (§5.4). Never send uploads through them; KYC files go browser → Storage directly. |
| `after()` | ✅ ("Support for after"). Maps to `ctx.waitUntil` | Optional, e.g. audit/Sentry flush in server actions. Not needed by the UI. |
| Turbopack builds | ✅ (docs). The changelog shows ongoing Turbopack-chunk patches for 16.3 (#1359) | Use Turbopack (the scaffold does). If a "Failed to load chunk" error appears, upgrade the adapter or fall back to `next build --webpack` (troubleshooting.mdx). |
| `instrumentation.ts` (Sentry server) | Works in the server function; the Node proxy bundle has the instrumentation loader stubbed (#1359), so **Sentry does not auto-instrument `proxy.ts`**. | `instrumentation.ts` with `@sentry/nextjs` `register()`; `instrumentation-client.ts` for the browser. Follow Sentry's "Deploying on Cloudflare" guide (<https://docs.sentry.io/platforms/javascript/guides/nextjs/best-practices/deploying-on-cloudflare>): `nodejs_compat` is required and the compatibility date must be recent (already `2026-10-15`). Treat server-side tracing as best-effort; earlier reports showed flush/`waitUntil` gaps (getsentry/sentry-javascript PR #18330). Do **not** enable Sentry `tunnelRoute`, which would route every browser event through the Worker; send events directly to Sentry ingest. Upload source maps at build (`@sentry/wizard -i sourcemaps`). |
| `not-found.tsx`, `error.tsx`, `global-error.tsx`, `loading.tsx` | ✅ | Used. |
| `generateMetadata` reading request data | Would force SSR | Use static `export const metadata`. |
| `cookies()` / `headers()` in pages/layouts | Works, but makes the route dynamic (SSR per hit) | Banned in pages/layouts (`dynamic = 'error'`). Used only in route handlers and server actions. |
| Workers runtime caveats | "Cannot perform I/O on behalf of a different request": no global DB clients | Create Supabase server clients per request (already the `@supabase/ssr` pattern). |

**Incompatible or problematic features and their replacements:**
- ISR/revalidate → static + client fetch.
- `next/image` optimization → `unoptimized`.
- Edge runtime → Node runtime (never export `runtime`).
- `proxy.ts` (experimental on OpenNext) → smoke-test it, with edge `middleware.ts` as the fallback.
- `next/og` → static OG images.
- Large uploads via server actions → direct-to-Storage.
- Sentry `tunnelRoute` → direct ingest.
- `cacheComponents`/`use cache` with time-based lifetimes → off.

---

## 7. Bundle-size notes (10 MiB compressed Worker limit)

- **What counts:** only code the *server* bundle imports, meaning server components, route handlers, server actions, proxy and instrumentation. Client-only modules that are reachable only from `'use client'` files are emitted as static JS chunks in `.open-next/assets`, served by Workers Static Assets, and **do not count toward the 10 MiB Worker** (they count toward page weight). The SSR pass still renders client components to HTML, so a client component imported into a prerendered page *is* in the server bundle unless it is loaded with `next/dynamic(..., { ssr: false })`.
- **Heavy client libs and how to isolate them:**

| Library | Approx. size | Rule |
|---|---|---|
| `lightweight-charts@5.2.1` | ~45 KB brotli for `createChart` (repo `.size-limit.js`), ~53 KB for everything | It is client-only by design ("not designed to work on the server side"). Load `PriceChart`/`DepthChart` through `next/dynamic(() => import(...), { ssr: false })` from a client wrapper, so it stays out of the server bundle and out of SSR. Import only the series/plugins used. |
| `motion` (Framer Motion) | full `motion` ≈ 30+ KB gz; `LazyMotion`+`m` ≈ 5 KB initial | Use `LazyMotion features={domAnimation}` and `m.*`. Import from `motion/react`. Only in client components. On marketing pages, wrap section animations in client islands; the static HTML renders without them. |
| Drawing-tools plugin (D5) | 20–80 KB | Dynamic import only when the Forex toolbar is first used. |
| `recharts` (via shadcn `chart`) | ~100 KB gz | Assets profit chart only. Use `next/dynamic` with `ssr: false`. Alternatively draw the profit chart with lightweight-charts `AreaSeries`/`BaselineSeries` and drop Recharts entirely (recommended, saves a dependency). |
| `@tanstack/react-table`, `react-hook-form`, `zod` | small–medium | Fine. Keep `zod` schemas in shared files that are only imported where needed. |
| `qrcode` | ~25 KB | Deposit page only, dynamically imported. |
| `@supabase/supabase-js` | ~50 KB gz client; on the server only `@supabase/ssr` + auth in proxy/handlers | Fine. Do not import `@supabase/supabase-js` admin code into shared modules. Create the secret-key client only inside `admin/_actions.ts`. |
| `@sentry/nextjs` | server SDK adds to the Worker | Keep integrations minimal (no profiling, no replay on the server). Browser replay is optional and lazy-loaded. |

- **Guardrails:**
  1. Lint rule: `lightweight-charts`, `motion`, `recharts` and `qrcode` may only be imported from files with `'use client'` (`no-restricted-imports` with overrides).
  2. CI step: after `opennextjs-cloudflare build`, fail if `wrangler deploy --dry-run` reports gzip > 8 MiB, which leaves headroom. Inspect with `.open-next/server-functions/default/handler.mjs.meta.json` in the esbuild analyzer (troubleshooting.mdx).
  3. Never use `next/og`.
  4. Keep translation messages small; `en.json` is imported into the server bundle.

---

## 8. Open decisions

| ID | Decision | Option | Good | Bad |
|---|---|---|---|---|
| D1 | i18n routing | **A. No `[locale]` (recommended)** | Zero proxy work for public pages; trivially static; simplest URLs | Adding a 2nd locale later needs a folder move + middleware |
| | | B. `[locale]` + `localePrefix: 'as-needed'` now | Future-proof URLs | Needs `generateStaticParams`/root-params plus next-intl middleware on *all* routes (the matcher can no longer be protected-only) |
| | | C. `[locale]` + `localePrefix: 'never'` (cookie) | Clean URLs | Rewrites every request through middleware, which conflicts with R4 |
| D2 | Proxy file | **A. `proxy.ts` (Node), smoke-tested on day 1 (recommended)** | Matches Next 16 and the current Supabase docs; not deprecated | OpenNext support is "experimental" (1.20.3+); Sentry is not instrumented there |
| | | B. `middleware.ts` (edge) | Stable path in OpenNext; same code | Deprecated in Next 16 and will be removed in a future major |
| D3 | Terminal symbol in URL | **A. `?symbol=` + `history.replaceState` (recommended)** | One static file per terminal; symbol switches cost no Worker request | Less pretty URLs; must read inside `<Suspense>` |
| | | B. `/spot/[symbol]` + `generateStaticParams` from a checked-in list | Pretty URLs, still static | New symbols need a redeploy; each switch is a navigation |
| D4 | Passkeys | **A. Supabase native passkeys (beta, May 2026; `auth: { experimental: { passkey: true } }`, `registerPasskey()` / `signInWithPasskey()` / `auth.passkey.list/update/delete`, supabase-js ≥ 2.105) (recommended)** | No server code or secrets; sessions issued by Supabase; RP ID/origins set in the dashboard | Experimental API "may change without notice"; JS docs cover first-factor sign-in only (WebAuthn as an MFA factor appears only in the Swift SDK so far); RP ID must be fixed before users enroll |
| | | B. `@simplewebauthn/server@14` in server actions + a custom `webauthn_credentials` table, minting a session through a custom flow | Full control; can act as a true 2nd factor | Needs `SUPABASE_SECRET_KEY` + session-minting workaround; more Worker CPU; security-sensitive custom code |
| | | C. Defer passkeys; ship TOTP + phone MFA only | Smallest scope | The Security Center spec item stays unchecked |
| D5 | Forex drawing tools | **A. Own primitives via `ISeriesPrimitive`, porting the official plugin examples (`trend-line`, `rectangle-drawing-tool`, `vertical-line`, `user-price-lines`, `anchored-text`) (recommended)** | Apache-2.0 examples, small, full style control | ~3–5 dev-days; fib/channels need extra work |
| | | B. Community lib, e.g. `deepentropy/lightweight-charts-drawing` (v0.1.x, 68 tools, v5 primitives) | Many tools at once | Immature (0.1), unknown maintenance; audit the license and size |
| | | C. Persist drawings in Supabase (`chart_drawings` table) instead of localStorage | Syncs across devices | One more table plus RLS; write traffic on every edit |
| D6 | Forex order mechanics | **A. Same as spot (buy/sell base against quote in the Forex wallet) (recommended for v1)** | Reuses SpotOrderForm + `place_order` RPC | Not "real" FX (no leverage or margin) |
| | | B. Margin positions with leverage, SL/TP | Realistic | New data model, liquidation engine and UI; out of v1 scope |
| D7 | KYC gating | **A. Require KYC=approved for withdrawals only (recommended)** | Low friction for practice | Users may deposit before verifying |
| | | B. Require KYC before any trading | Strict | Blocks onboarding in a practice product |
| D8 | Profit chart source | **A. `portfolio_snapshots` from an hourly pg_cron job valued with server-side prices (recommended)** | Cheap reads; consistent history | Needs a server-side price source (see conflicts) |
| | | B. Compute from the ledger on the client | No cron | Can't value historical holdings without historical prices |
| D9 | Admin auth-level operations (ban, reset MFA) | **A. A few server actions with `SUPABASE_SECRET_KEY` (recommended)** | Small surface; the secret stays in a Worker secret | One secret-holding code path to audit |
| | | B. A Supabase Edge Function with the service role, called from the browser with the admin JWT | No secrets in the Next app at all | One more deploy target |
| D10 | Chart library attribution | **A. Keep the default `attributionLogo: true` on the chart (recommended)** | Satisfies the Apache-2.0 NOTICE requirement ("specifying TradingView as the product creator" + link) | A small third-party logo appears on the chart |
| | | B. `attributionLogo: false` + attribution text and link on `/legal/risk` and in the footer | Cleaner chart | Must be kept visible to users as the license requires |

---

## 9. Contracts expected from the other agents

### 9.1 Data-model agent: tables, views and RPCs the UI expects

> **Superseded at merge.** This list was the UI agent's request. The authoritative names and shapes are in `docs/data-model.md`, and its §12 maps each item below to what was adopted.

Tables (all RLS; "public read" means readable by `anon` and `authenticated`):
- `profiles(id uuid pk = auth.uid, uid_display text unique /* short numeric UID shown in UI */, nickname, email, phone, country, kyc_status enum('none','pending','approved','rejected'), role enum('user','admin'), created_at)`. Email/phone are mirrored from `auth.users` by trigger. `role` must also be copied to `app_metadata.role` (custom access token hook or admin RPC) so the proxy and `is_admin()` can read it from the JWT.
- `wallets(user_id, wallet enum('capital','spot','forex','options'), asset text, available numeric, locked numeric, updated_at, pk(user_id, wallet, asset))`
- `ledger_entries(id, user_id, wallet, asset, amount numeric /*signed*/, balance_after, kind enum('admin_credit','admin_debit','deposit','withdrawal','transfer_in','transfer_out','trade','fee','option_premium','option_payout','option_refund'), ref_table, ref_id, note, created_at)`. This feeds Bills.
- `instruments(symbol pk /* 'BTC-USDT' */, category enum('spot','forex','options'), base, quote, price_precision, qty_precision, min_qty, min_notional, enabled, sort, provider_symbol)`. Public read.
- `favorites(user_id, symbol, pk(user_id, symbol))`
- `orders(id, user_id, market enum('spot','forex'), symbol, side, type enum('limit','market'), price, qty, filled_qty, avg_price, status enum('open','partially_filled','filled','canceled','rejected'), created_at, updated_at)` and `fills(id, order_id, user_id, symbol, side, price, qty, fee, fee_asset, created_at)`
- `option_cycles(seconds pk, profit_rate numeric, fee_rate numeric, min_premium, max_premium, enabled, updated_at)`. Public read; admin write.
- `option_orders(id, user_id, symbol, direction enum('rise','fall'), cycle_seconds, premium, fee, profit_rate /*snapshot*/, entry_price, opened_at, expires_at, settle_price, status enum('open','won','lost','draw','canceled'), payout, settled_at)`
- `asset_networks(asset, network, deposit_address /* removed: no address is ever stored (O10) */, memo, min_deposit, min_withdraw, withdraw_fee, enabled)`. Public read. Fiat equivalent: `fiat_methods(currency, method, instructions, min, max, fee)`.
- `deposit_requests(id, user_id, kind enum('crypto','fiat'), asset, network, amount, tx_ref, status enum('pending','approved','rejected'), reviewer_id, review_note, created_at, reviewed_at)`
- `withdrawal_requests(id, user_id, kind, asset, network, address /* or beneficiary jsonb */, amount, fee, status enum('pending','approved','rejected','canceled'), reviewer_id, review_note, created_at, reviewed_at)`. Funds move to `locked` on create.
- `kyc_submissions(id, user_id, country, doc_type enum('passport','id_card','driver_license'), first_name, last_name, dob, address jsonb, doc_front_path, doc_back_path, selfie_path, status, reviewer_id, review_note, created_at, reviewed_at)`, plus Storage bucket `kyc` (private; path `kyc/{uid}/...`; insert-own, select-own, select-admin).
- `portfolio_snapshots(user_id, ts, total_usd, pnl_usd)` (D8)
- `admin_audit_log(id, admin_id, action, target_user, payload jsonb, created_at)`

RPCs (SECURITY DEFINER where they move money; all validate `auth.uid()`):
- `server_time() → timestamptz`
- `place_spot_order(symbol, side, type, price?, qty?, quote_qty?) → orders row`. A market buy by percent needs `quote_qty`.
- `place_forex_order(...)` (or one `place_order(market, …)`)
- `cancel_order(id)`
- `place_option_order(symbol, direction, cycle_seconds, premium) → { order, server_now }`
- `transfer_between_wallets(from_wallet, to_wallet, asset, amount)`
- `create_deposit_request(...)`, `create_withdrawal_request(...)`, `cancel_withdrawal_request(id)`
- `submit_kyc(...)`, `update_profile(nickname)`, `toggle_favorite(symbol)`
- `get_option_stats(range)` (or view `option_stats_v`)
- Admin: `admin_adjust_balance(user_id, wallet, asset, amount, reason)`, `admin_review_deposit(id, approve bool, note)`, `admin_review_withdrawal(id, approve, note)`, `admin_review_kyc(id, approve, note)`, `admin_upsert_option_cycle(...)`, `is_admin()`

Realtime: the UI subscribes to `postgres_changes` filtered by `user_id=eq.<uid>` on `wallets`, `orders`, `fills`, `option_orders`, `deposit_requests`, `withdrawal_requests` and `kyc_submissions`, plus `option_cycles` (all rows). Admins subscribe to pending inserts on the three queues. The alternative is DB-trigger **broadcast** to private channels `user:<uid>`, which scales better; the data-model agent picks, and the UI hook is the same shape. Either way the tables must be in the `supabase_realtime` publication (or broadcast triggers must exist).

### 9.2 Market-data agent: what the UI consumes

- One client provider, `MarketDataProvider`, mounted in RootLayout, exposing `useTicker`, `useTickers(symbols[])` (bulk, for MarketList and Assets valuation), `useOrderBook`, `useTrades`, `useCandles(symbol, tf)` (history + live), and `useFeedStatus`. All timeframes must be served: 1m, 5m, 15m, 30m, 1h, 4h, 1D, 1W, 1M.
- The provider must work on static pages (no server props) and must not open duplicate upstream connections across components or tabs.

---

## 10. Anticipated conflicts (raise at merge)

1. **Server-trusted prices for settlement and fills (data-model ↔ market-data).** Browser-fetched prices cannot be trusted to settle options, fill market/limit orders, or value `portfolio_snapshots`. Someone must own a **server-side price source**: a Supabase Edge Function or pg_cron + `http` fetching the same public APIs and writing `price_ticks`/`settlement_prices`, or the shared Worker route writing into Supabase. The UI assumes `place_*` RPCs read the price server-side and that settlement arrives via Realtime.
2. **Forex order book, trades and volume do not exist publicly.** Spot FX/metals have no consolidated public order book, tape or volume. The Forex terminal spec (order book, latest trades, volume MA5/10/20, depth chart) therefore needs **synthetic** data generated around the mid price, or tick-count volume, from the market-data agent. Otherwise the UI must hide those panels for forex. Probes in this session showed several free FX/metal APIs blocked from the sandbox, so availability is unconfirmed.
3. **Options terminal symbols.** "Options" here means binary up/down on an underlying. `instruments.category = 'options'` needs an underlying price feed, which is likely the same crypto/forex feeds. Agree whether options symbols reuse spot/forex symbols (`BTC-USDT`, `XAU-USD`) or are separate rows.
4. **USD valuation of balances.** The Assets total needs a price for every held asset, including assets not on screen. The market store must support a cheap bulk ticker (`useTickers`) or the Worker route `/md/v1/tickers?symbols=`. Otherwise the data-model agent must expose a server-valued `wallet_totals_v`.
5. **Admin role claim.** Resolved: the proxy reads the top-level `user_role` claim, set by the custom access token hook from `user_roles`.
6. **Asymmetric JWT keys** must be enabled on the Supabase project, or R4 degrades into a network call per request.
7. **Realtime channel naming.** The UI uses `crypto.randomUUID()` suffixes. If the data-model agent chooses private broadcast channels with RLS on `realtime.messages`, policies must match by topic **prefix** (e.g. `split_part(topic, ':', 2) = auth.uid()::text`) and not by exact name.
8. **Decimal handling.** The UI sends amounts as strings and expects `numeric` columns returned as strings. Resolved: PostgREST returns `numeric` as JSON numbers, so every select of a numeric or money column casts with `::text`. RPC args should be `numeric` and not `float8`.
9. **Chart attribution vs. the "no third-party brands" rule.** Lightweight Charts' Apache-2.0 NOTICE requires crediting TradingView as the product creator, with a link. That is a license obligation and not exchange branding, but the main agent should confirm (D10).

### 4.11 Slice 3 screens as shipped (market table and Market tab)

| Screen | Path | Evidence |
|---|---|---|
| Home market table (tabs, type dropdown, Symbol / Sell / Buy / Change) | `/home` | Captured |
| Market tab (the same table at full height, search field, star toggles) | `/market` | Designed |
| Top bar search (submits to `/market?q=`) | every top-bar page | Designed |

Assumptions:
- **Columns:** Symbol shows `display_symbol` (for example `BTCUSD`) with the ticker's own last update time beneath, or "Delayed" when it is older than 60 s. Sell is the best bid and Buy the best ask from the exchange tickers; no spread is invented. Change is the 24 h percent, green when positive, red when negative, neutral at 0.00%. Prices use the market's `price_decimals`.
- **Tabs:** Optional (the user's favorites), Popular (24 h quote volume), Gainer (change high to low), Down (change low to high). The default tab is Popular, so a new user sees data first. The Optional empty state says to star a pair in the Market tab and links there from Home.
- **Type dropdown:** a native select. Spot is the only enabled option; Options, Forex and Perpetual are disabled and read "Soon".
- **Home:** the table shows the first 8 rows of the active tab and a "See all markets" link to `/market`. The 8 is our choice.
- **Market tab:** search matches the display symbol, the base asset, the id and `BASE/QUOTE`, case-insensitively, inside whichever tab is active. A star on each row adds or removes a favorite at once and undoes itself if the save fails. The top bar search form sends `/market?q=text`; the page field follows the URL when it changes and can then be edited freely.
- **Coin icons:** a circle with the first two letters of the base asset. No third-party logos are downloaded or bundled.
- **Row tap:** saves the symbol id under `aureonx.lastMarket` in `localStorage` (inside try/catch) and does not navigate. The Trade tab opens `/spot`, which is "Coming soon" until slice 4 (O24).
- **States:** "Loading markets", an amber "Prices are temporarily unavailable. Retrying." when every provider has failed and nothing was loaded, and a one-line footnote that prices refresh about every 5 seconds.
- **Layout:** built at 390 px. Prices use 13 px tabular numbers, and the symbol column keeps a minimum width so `NEARUSD` does not truncate next to the star. Scrolling pages keep the tab bar plus safe-area padding from the group layout.

### 4.12 Slice 4 screens as shipped (Spot terminal)

| Screen | Path | Evidence |
|---|---|---|
| Spot terminal (header, chart, order form, Book / Trades / Orders) | `/spot?symbol=BTC-USDT` | Designed |
| Market picker sheet (search, favorites, live prices) | opened from the terminal header | Designed (reuses the Market tab table) |
| Order history and Holdings | `/spot`, Orders tab | Designed |

Assumptions:
- **Placement:** the page sits directly in `(app)`, so it keeps the tab bar but has its own header instead of the top bar: the display symbol with a chevron (opens the picker), the 24 h change, the last price (with "Delayed" after 60 s) and the VIRTUAL pill. The page keeps the tab bar plus safe-area bottom padding.
- **Phone order (390 px):** header, chart (280 px), order form, then the Book / Trades / Orders tabs. From `md:` the chart and the form sit side by side (form 340 px) and the tabs run full width below. This replaces §4.1's sticky Buy/Sell bar and drawer: the brief asked for an inline Buy/Sell toggle, which is simpler on a phone.
- **Symbol:** `?symbol=` wins; without it the last viewed market (`aureonx.lastMarket`) opens, else BTC-USDT. An unknown or disabled symbol falls back to BTC-USDT. Viewing a market saves it as the last viewed. Picking a market updates the URL with `history.replaceState` (no navigation, no Worker request). The Trade tab and the Home Spot tile link to `/spot`.
- **Chart:** default timeframe 15m. Buttons 1m 5m 15m 30m 1h 4h and a More menu with 1D and 1W. Candles only (no volume or indicators yet). "Loading chart…" until the first candles, and "Chart unavailable. Retrying." over the chart while both sources fail. Price axis uses the market's `price_decimals`.
- **Order form:** Buy / Sell toggle (switching clears the quantity and any result). Market tab active; Limit is disabled with a "Soon" badge. Available shows USD for Buy and the base asset for Sell. Quantity is a decimal field checked as you type: allowed decimals per market (`qty_decimals`), minimum order value, the available USD (Buy, cost plus fee) or the holding (Sell). The slider has stops at 0, 25, 50, 75 and 100 %: Buy uses that share of the available USD at the shown ask including the fee, and 100 % prices at the ask plus 0.5 % (`MAX_BUY_BUFFER_BPS`) so a slightly higher server ask still fits; 100 % Sell is the full holding; Sell uses that share of the holding, rounded down to the allowed decimals.
- **Estimate:** a block labelled "Estimate" with the shown price (ask for Buy, bid for Sell), cost or proceeds and the fee at `spot_config.fee_bps`, rounded like the server (cost and fee up, proceeds down). A note says the order fills at the server's latest price.
- **Confirm:** "Buy BTC" / "Sell BTC", disabled while a request is in flight, while the form has a problem, and with the label "Prices unavailable" when the browser has no ticker for the market. One idempotency key per confirm attempt, reused when the request got no answer.
- **After a fill:** an "Order filled" card with the fill quantity, price, cost or proceeds and fee read back from the order row (as text), not the estimate.
- **Errors:** PRICE_STALE "Prices are refreshing. Try again in a few seconds."; not enough USD or coin in plain words; below the minimum shows the minimum in USD; too many decimals shows the allowed decimals; IDEMPOTENCY_CONFLICT asks to check the orders and try again; a lost connection keeps the key and says pressing confirm again is safe.
- **Empty Spot wallet:** a one-line hint with a link to Transfer.
- **Stats strip:** under the header, 24h High, 24h Low and 24h quote volume (compact, display only) from the ticker.
- **Book:** a Both / Bids / Asks toggle (Both: 10 asks, the mid price of the best bid and ask, 10 bids; one side: 20 levels). Each row has a depth bar sized by cumulative quantity from the best price, scaled to the largest shown total. No precision grouping; price in red/green, amount rounded to the market's quantity decimals. **Trades:** newest 30, time (24 h), price colored by the taker side, amount. Both carry the note "Live market depth. Practice orders fill at the quoted price and do not enter this book." and show "unavailable" when Vision fails.
- **Orders tab:** two chips, Order history (newest 50 orders across all markets: side, pair, Market, Filled, quantity, price, cost or proceeds, fee, realized PnL on sells, local time) and Holdings (coins with a balance above zero: quantity and cost basis). No pagination yet. The lists reload when the Spot wallet changes (Realtime) and after each fill.
- **Picker:** a bottom sheet (Radix Dialog) holding the Market tab table: search, Optional / Popular / Gainer / Down, stars, live Sell / Buy / Change. A row tap switches the terminal and closes the sheet.
