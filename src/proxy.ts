import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { supabasePublishableKey, supabaseUrl } from "@/lib/supabase/env";

// Runs on protected routes only (see matcher). Verifies the JWT locally with
// getClaims() (ES256 + cached JWKS) and refreshes the session cookies.
// Sentry does not capture errors here on Workers, so errors are logged and the
// request fails closed to the sign-in page.
export async function proxy(request: NextRequest) {
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
    if (error || !data?.claims) return signIn();
    return response;
  } catch (err) {
    console.error("proxy: auth check failed", err);
    return signIn();
  }
}

export const config = {
  matcher: ["/account/:path*"],
};
