import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { safeNext } from "@/lib/safe-next";
import { createClient } from "@/lib/supabase/server";

// Email links (password recovery; older signup confirmations) land here with a
// token_hash. verifyOtp sets the session cookies, then we redirect.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;

  if (tokenHash && type) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) {
      const fallback = type === "recovery" ? "/update-password" : "/home";
      return NextResponse.redirect(new URL(safeNext(searchParams.get("next"), fallback), origin));
    }
    console.error("auth/confirm: verifyOtp failed", error.code ?? error.message);
  }
  return NextResponse.redirect(new URL("/sign-in?error=link", origin));
}
