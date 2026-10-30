"use client";

import { useEffect, useState } from "react";
import { fetchAdminRole } from "@/lib/admin";
import { createClient } from "@/lib/supabase/client";

// Whether the signed-in user's own user_roles row is a head admin; null while
// loading. UX only: admin_set_admin checks the live row itself.
export function useHeadAdmin(): boolean | null {
  const [isHead, setIsHead] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    createClient()
      .auth.getClaims()
      .then(async ({ data }) => {
        const id = data?.claims.sub;
        const role = id ? await fetchAdminRole(id) : null;
        if (active) setIsHead(role?.isHead === true);
      });
    return () => {
      active = false;
    };
  }, []);
  return isHead;
}
