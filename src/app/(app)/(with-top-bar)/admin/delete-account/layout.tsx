import { redirect } from "next/navigation";
import { isHeadAdmin } from "@/lib/admin-server";
import { createClient } from "@/lib/supabase/server";

// Head admin only, like admin-access/layout.tsx: an admin who is not a head admin
// goes back to /admin before the page renders. The RPCs check it again in SQL.
export default async function HeadAdminLayout({ children }: { children: React.ReactNode }) {
  if (!(await isHeadAdmin(await createClient()))) redirect("/admin");
  return children;
}
