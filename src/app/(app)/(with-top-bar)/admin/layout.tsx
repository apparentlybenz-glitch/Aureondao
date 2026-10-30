import { redirect } from "next/navigation";
import { AdminShell } from "@/components/admin/admin-shell";
import { isAdmin } from "@/lib/admin-server";
import { createClient } from "@/lib/supabase/server";

// The (app) layout is static (dynamic = "error"); the admin pages render per
// request so a non-admin is redirected before any admin page renders. This only
// stops the pages rendering: RLS and the admin RPCs stay the data boundary.
export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  if (!(await isAdmin(await createClient()))) redirect("/home");
  return <AdminShell>{children}</AdminShell>;
}
