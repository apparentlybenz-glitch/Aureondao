import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { supabasePublishableKey, supabaseUrl } from "@/lib/supabase/env";

// Runs on protected routes (see matcher) and on the public root. Verifies the
// JWT locally with getClaims() (ES256 + cached JWKS) and refreshes the session
// cookies. Protected routes fail closed to the sign-in page. The root is the
// public landing page: a valid login token sends the visitor to /home, anything
// else (no cookie, bad token, an error) falls through to the landing page.
// Sentry does not capture errors here on Workers, so errors are logged.
const AUTH_COOKIE = /^sb-.+-auth-token(\.\d+)?$/;

export async function proxy(request: NextRequest) {
  const isRoot = request.nextUrl.pathname === "/";
  // Signed-out visitors carry no auth cookie: skip the token check entirely.
  if (isRoot && !request.cookies.getAll().some(({ name }) => AUTH_COOKIE.test(name))) {
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
    if (error || !data?.claims) return isRoot ? response : signIn();
    if (isRoot) {
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
    return isRoot ? NextResponse.next({ request }) : signIn();
  }
}

export const config = {
  // Every protected page, plus "/" for the signed-in redirect. The proxy only
  // routes; RLS and the RPC checks are the security boundary.
  matcher: [
    "/",
    "/home",
    "/account/:path*",
    "/assets/:path*",
    "/admin/:path*",
    "/market",
    "/spot",
    "/options",
    "/support",
    "/notifications",
  ],
};
