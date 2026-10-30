import "server-only";
import type { createClient } from "@/lib/supabase/server";

// The live admin row, read as the signed-in user (RLS: a user reads their own
// row). Live row only, no claim check, on purpose: the admin RPCs check the
// user_role claim and the live row, and server code reads data under RLS, which
// needs the live row alone. A user just granted admin passes here before their
// token carries the claim.
export async function isAdmin(supabase: Awaited<ReturnType<typeof createClient>>): Promise<boolean> {
  const { data: auth } = await supabase.auth.getClaims();
  const userId = auth?.claims.sub;
  if (!userId) return false;
  const { data: role } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  return role !== null;
}
