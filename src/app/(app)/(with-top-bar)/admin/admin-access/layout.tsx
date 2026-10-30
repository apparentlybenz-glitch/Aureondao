import { redirect } from "next/navigation";
import { isHeadAdmin } from "@/lib/admin-server";
import { createClient } from "@/lib/supabase/server";

// Nested in the admin layout, which already makes /admin/* dynamic. Sends an
// admin who is not a head admin back to /admin before the page renders.
export default async function AdminAccessLayout({ children }: { children: React.ReactNode }) {
  if (!(await isHeadAdmin(await createClient()))) redirect("/admin");
  return children;
}
