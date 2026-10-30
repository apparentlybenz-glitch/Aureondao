import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { supabasePublishableKey, supabaseUrl } from "@/lib/supabase/env";

// Runs on protected routes (see matcher) and on the public entry pages (the
// landing page, /sign-in, /sign-up). Verifies the JWT locally with getClaims()
// (ES256 + cached JWKS) and refreshes the session cookies. Protected routes fail
// closed to the sign-in page. An entry page with a valid login token redirects
// to /home; anything else (no cookie, bad token, an error) falls through to the
// page. /sign-in/mfa is deliberately not an entry page: a signed-in user at AAL1
// needs it. Sentry does not capture errors here on Workers, so errors are logged.
const ENTRY_PAGES = ["/", "/sign-in", "/sign-up"];
const AUTH_COOKIE = /^sb-.+-auth-token(\.\d+)?$/;

export async function proxy(request: NextRequest) {
  const isEntry = ENTRY_PAGES.includes(request.nextUrl.pathname);
  // Signed-out visitors carry no auth cookie: skip the token check entirely.
  if (isEntry && !request.cookies.getAll().some(({ name }) => AUTH_COOKIE.test(name))) {
    return NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });

  const signIn = () => {
    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    url.search = `?next=${encodeURIComponent(request.nextUrl.pathname + request.nextUrl.search)}`;
    return NextResponse.redirect(url);
  };

  try {
    const supabase = createServerClient(supabaseUrl, supabasePublishableKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
          for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
        },
      },
    });

    const { data, error } = await supabase.auth.getClaims();
    if (error || !data?.claims) return isEntry ? response : signIn();
    if (isEntry) {
      const url = request.nextUrl.clone();
      url.pathname = "/home";
      url.search = "";
      const redirect = NextResponse.redirect(url);
      // Keep any refreshed session cookies; the answer depends on the visitor.
      for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
      redirect.headers.set("Cache-Control", "private, no-store");
      return redirect;
    }
    return response;
  } catch (err) {
    console.error("proxy: auth check failed", err);
    return isEntry ? NextResponse.next({ request }) : signIn();
  }
}

export const config = {
  // Every protected page, plus the entry pages "/", "/sign-in" and "/sign-up" for the signed-in redirect. The proxy only
  // routes; RLS and the RPC checks are the security boundary.
  matcher: [
    "/",
    "/sign-in",
    "/sign-up",
    "/home",
    "/account/:path*",
    "/assets/:path*",
    "/admin/:path*",
    "/market",
    "/spot",
    "/options",
    "/forex",
    "/support",
    "/legal",
  ],
};
