import { NextResponse, type NextRequest } from "next/server";
import { safeNext } from "@/lib/safe-next";
import { createClient } from "@/lib/supabase/server";

// PKCE code exchange for links that carry ?code= (for example an email change
// confirmed through the default {{ .ConfirmationURL }} template).
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(new URL(safeNext(searchParams.get("next")), origin));
    }
    console.error("auth/callback: code exchange failed", error.code ?? error.message);
  }
  return NextResponse.redirect(new URL("/sign-in?error=link", origin));
}
