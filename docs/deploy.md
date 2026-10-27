# Deploying AureonX to Cloudflare Workers (Workers Builds)

This guide covers deploying the app from GitHub with **Workers Builds** (Cloudflare's Git integration) into the new Cloudflare account. It describes the repo as of slice 1.

Placeholders used below:
- `<subdomain>`: the account's workers.dev subdomain (Workers & Pages → Overview → "Your subdomain"; you pick it on first use).
- `<ref>`: the Supabase project ref (the `SUPABASE_PROJECT_REF` value).

The production URL is `https://aureonx.<subdomain>.workers.dev`. `aureonx` comes from `name` in `wrangler.jsonc`.

**Never commit values.** Every value below goes into the Cloudflare or Supabase dashboard, not into the repo.

---

## 1. Workers Builds settings

Create the Worker: **Workers & Pages → Create → Import a repository → GitHub → `apparentlybenz-glitch/Aureondao`**. Then set the following (later edits: Worker → **Settings → Build**).

| Setting | Value | Why |
|---|---|---|
| Project / Worker name | `aureonx` | Must equal `name` in `wrangler.jsonc`, or the deploy step fails. |
| Production branch | `main` | |
| Root directory | `/` (leave blank) | The app is at the repo root. |
| Build command | `pnpm build:worker` | Runs `opennextjs-cloudflare build`, which runs `next build` and writes `.open-next/`. `worker.ts` imports `.open-next/worker.js`, so nothing can deploy before this step. |
| Deploy command | `pnpm exec opennextjs-cloudflare deploy` | Copies the prerendered pages into the static-assets cache (`populateCache`), then runs `wrangler deploy`. A bare `wrangler deploy` does not run that copy itself. |
| Builds for non-production branches | **Enabled** | Every push to another branch builds and uploads a **preview version**, which never serves production traffic. |
| Non-production branch deploy command | `pnpm exec opennextjs-cloudflare upload` | Same cache copy, then `wrangler versions upload`. This creates a version with a preview URL and does not deploy it. |
| Build watch paths | default (everything) | |

Install step: Workers Builds detects pnpm from `pnpm-lock.yaml` and runs the install before the build command. Pin the toolchain with the build variables in §2 (`NODE_VERSION`, `PNPM_VERSION`).

Preview versions use the **same Supabase project** as production. There is no separate Supabase project per branch (Free plan, O19).

---

## 2. Variables

Next.js compiles every `NEXT_PUBLIC_*` value into the bundles at build time. That includes the proxy bundle: the slice 1 build contains the Supabase URL as a literal and does no runtime lookup. So these values must be **build variables**. Setting them as Worker runtime variables does nothing.

If either Supabase variable is missing, `next build` fails with `Missing environment variable: NEXT_PUBLIC_SUPABASE_URL` (checked on a clean checkout). A missing value cannot ship silently.

### 2.1 Build variables

Set these under Worker → **Settings → Build → Variables and secrets**. They are used only while building.

| Variable | Required | Secret | Notes |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | **yes** | no | `https://<ref>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | **yes** | no | The `sb_publishable_...` key. Public by design; RLS protects the data. |
| `NODE_VERSION` | recommended | no | `22` (the version the build was verified on). |
| `PNPM_VERSION` | recommended | no | `10.28.0` (matches `packageManager` in `package.json`). |
| `NEXT_PUBLIC_SITE_URL` | optional | no | The production origin, for example `https://aureonx.example`. Set it in the Cloudflare Workers Builds variables for production. It becomes `metadataBase`, so Open Graph image URLs are absolute. Unset or invalid: `metadataBase` stays unset and they resolve against `http://localhost:3000`. |
| `NEXT_PUBLIC_SENTRY_DSN` | optional | no | Browser Sentry DSN. Without it, browser Sentry stays off. |
| `SENTRY_ORG` | optional | no | Source-map upload only. |
| `SENTRY_PROJECT` | optional | no | Source-map upload only. |
| `SENTRY_AUTH_TOKEN` | optional | **yes** | Source-map upload only. Add it as a build **secret**. |

### 2.2 Runtime variables (the Worker's env)

Set these under Worker → **Settings → Variables and secrets**.

| Variable | Required | Secret | Notes |
|---|---|---|---|
| `SENTRY_DSN` | optional | add as **Secret** | Server-side Sentry, read by `worker.ts`. Without it, server Sentry stays off. Use the Secret type: `wrangler deploy` removes plain-text dashboard variables that are not in `wrangler.jsonc`, but it keeps secrets. |

### 2.3 Do not set

- `SUPABASE_SECRET_KEY`: no runtime code uses it in slice 1 (`src/lib/supabase/service.ts` is not imported anywhere). Do not add it anywhere until a slice needs it.
- `SUPABASE_JWKS`: listed in `.env.example` as planned; the code does not read it.
- `SUPABASE_PROJECT_REF`: used by tooling only, not by the app.
- `NEXTJS_ENV`: only for the local `.dev.vars` preview.

---

## 3. Supabase URL configuration

In Supabase → **Authentication → URL Configuration**:

- **Site URL:** `https://aureonx.<subdomain>.workers.dev`
- **Redirect URLs.** Add these and keep the existing localhost entries for local development:
  - `https://aureonx.<subdomain>.workers.dev/auth/confirm`
  - `https://aureonx.<subdomain>.workers.dev/auth/callback`
  - Preview versions (optional, only if you sign in on preview URLs): `https://*-aureonx.<subdomain>.workers.dev/**`

Why these two paths:
- Sign-up (`emailRedirectTo`) and password reset (`redirectTo`) send users to `<origin>/auth/confirm`.
- `/auth/callback` handles PKCE `?code=` links.

If a redirect URL is not on the list, Supabase falls back to the Site URL.

**Known limitation (open decision from the slice 1 report).** Custom email templates need custom SMTP, which is not configured. So the confirmation and reset emails use the default `{{ .ConfirmationURL }}` link:
- Supabase verifies the email, then redirects to `/auth/confirm?code=…`.
- `/auth/confirm` only accepts `token_hash`, so the user lands on `/sign-in` with "This link is invalid or has expired".
- The address **is** confirmed at that point, so signing in works.

The fix is either custom SMTP with `token_hash` templates, or routing these links through `/auth/callback`. That is the owner's call.

The default mailer also sends only to members of the Supabase organization's team, and only 2 emails per hour.

---

## 4. Post-deploy checklist

Run this against `https://aureonx.<subdomain>.workers.dev` after the first production deploy. Use a private window.

1. **Signed-out redirect**
   - Open `/account`. Expect to land on `/sign-in?next=%2Faccount`.
   - Repeat with `/account/security`.
   - From a terminal: `curl -sI https://aureonx.<subdomain>.workers.dev/account`. Expect `307` and `location: …/sign-in?next=%2Faccount`.
   - `curl -sI https://aureonx.<subdomain>.workers.dev/` returns `200` with no redirect for a signed-out request (the proxy also runs on `/`, `/sign-in` and `/sign-up`, but only redirects a request that carries a valid login token to `/home`; with no auth cookie it passes straight through).
2. **Sign up**
   - On `/sign-up`, use an address that is a member of the Supabase organization's team (default mailer, see §3).
   - Expect "Check your email". Open the link: you land on `/sign-in` with the invalid-link message (§3), and the address is now confirmed.
   - If "Confirm email" is off, sign-up goes straight to `/account` instead.
   - In Supabase SQL, the new user has exactly 1 `profiles` row and 4 `wallets` rows at 0:

     ```sql
     select count(*) from public.wallets where user_id = (select id from auth.users where email = '<address>');
     ```
3. **Sign in**
   - `/sign-in` with that address leads to `/account`.
   - The page shows the UID, the email, the KYC status "Not started" and the VIRTUAL FUNDS badge in the header.
   - Change the nickname and save. The button shows "Saved".
4. **TOTP step-up**
   - `/account/security` → Authenticator app → **Set up**. Scan the QR code, enter the code, then **Verify and turn on**. The status shows "On".
   - **Sign out**, then sign in again. Expect a redirect to `/sign-in/mfa?next=…`.
   - Enter a fresh code. Expect to land back on `/account`.
   - A wrong code shows an error and stays on the MFA page.
5. **Signed-out again**
   - After **Sign out**, opening `/account` redirects to `/sign-in?next=%2Faccount` (repeat step 1).

---

## 5. Worker logs and the "no Auth call on a warm request" check

`wrangler.jsonc` turns on Workers Logs, invocation logs and **traces**. It also sets `redact_query_string: true`, so one-time tokens in `/auth/confirm?token_hash=…` and `/auth/callback?code=…` are never logged. Traces record every outgoing `fetch` the Worker makes as a span. That is how you can see whether the proxy called Supabase Auth.

### 5.1 Where the logs are

- **Dashboard:** Workers & Pages → `aureonx` → **Observability**. Use the **Events/Logs** view for invocations and `console.*` output, and **Traces** for spans.
- **Live tail:** `pnpm exec wrangler tail aureonx --format pretty`. Run `pnpm exec wrangler login` into the new account first. Tail shows requests, status codes and `console.*` lines (for example `proxy: auth check failed`). It does not show outgoing fetches, so use Traces for §5.2.
- **Build and deploy logs:** Worker → **Deployments** (or **Builds**) → pick a build → **View build log**.

### 5.2 Confirming a warm request makes no Auth network call

`proxy.ts` calls `supabase.auth.getClaims()`. With the project's ES256 signing key, it verifies the JWT locally against a JWKS cached in isolate memory for 10 minutes. It goes to the network only in two cases:
- `GET https://<ref>.supabase.co/auth/v1/.well-known/jwks.json`, the first time an isolate verifies a token (cold), or after the 10-minute cache expires.
- `POST https://<ref>.supabase.co/auth/v1/token?grant_type=refresh_token`, when the access token is expired or about to expire (once per token lifetime, 1 hour by default).

Steps:
1. Sign in on the production URL (§4 step 3). Signing in from a fresh browser keeps the access token far from expiry.
2. Load `https://aureonx.<subdomain>.workers.dev/account` once. This request may be cold.
3. Within a minute, reload `/account` 3–5 more times.
4. Open Observability → **Traces** and filter to the `aureonx` service and the last 15 minutes. Open the traces for `GET /account`.
5. Expected:
   - At most the first request per isolate has a `fetch` span to `<ref>.supabase.co/auth/v1/.well-known/jwks.json`.
   - The later (warm) requests have **no `fetch` span to `<ref>.supabase.co`**. The proxy finishes with only local work, then the response is the static page.
   - A trace may show a token refresh call if the access token was close to expiry. Signing in again resets that.
6. If every request shows a JWKS fetch, requests are landing on new isolates (low traffic). Reload faster, or check several traces. One warm trace without the span is enough to prove the path.

Do not use Supabase's Auth logs for this check. The browser client also calls Supabase Auth directly (for example `getUser` on `/account/security`), so those logs mix browser traffic with Worker traffic. The Worker trace is the signal that matters.

---

## 6. Build and startup checks (verified 2026-10-25)

- **Clean checkout:**
  - `git clone` of `branch/jolly-shannon-sy3h3z`, then `pnpm install --frozen-lockfile && pnpm build:worker`, on Node 22.22.0. It succeeded in 72 s.
  - `wrangler deploy --dry-run` reports gzip **3,582 KiB** (limit 10 MiB).
- **Startup time:**
  - `wrangler deploy` prints `Worker Startup Time: <n> ms` only on a real deploy, which needs the Cloudflare account.
  - Locally, `pnpm exec wrangler check startup` measured **52.7 ms of active CPU** in a 335 ms profile window (the rest is idle) against the **400 ms** limit. Wrangler notes that a local CPU differs from Cloudflare's, so treat this as an estimate.
  - Read the real figure in the first Workers Builds deploy log (§5.1, deploy step, line `Worker Startup Time`).

## 7. Supabase price feed (slice 4)

The `price-ingest` Edge Function is deployed and both pg_cron jobs run, but the feed stays off until one shared secret exists in two places. Until then the function answers `500 not_configured`, `private.price_tick()` logs "vault secrets … missing" and sends nothing, and every Spot order gets `PRICE_STALE`.

Set it once (the owner; the value is never committed or printed):

1. Generate a random value, for example `openssl rand -hex 32`.
2. Dashboard → Edge Functions → Secrets: add `PRICE_INGEST_SECRET` with that value.
3. Dashboard → SQL Editor, with the same value:
   ```sql
   select vault.create_secret('https://bpntonctvsccrrgstemi.supabase.co', 'project_url');
   select vault.create_secret('<the value>', 'price_ingest_secret');
   ```
4. Check: sign in, open a trading screen (or run `select public.request_price_feed();` as a signed-in user), wait 20 s, then
   `select market_id, source, now() - fetched_at as age from public.price_snapshots order by market_id;` shows 20 rows a few seconds old.
   `select status_code, count(*) from net._http_response group by 1;` shows 200s.

To rotate: update both places with a new value (`vault.update_secret`). To stop the feed: `select cron.unschedule('aureonx-price-tick');`.
