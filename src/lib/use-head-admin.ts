"use client";

import { useEffect, useState } from "react";
import { type AdminRole, fetchAdminRole } from "@/lib/admin";
import { createClient } from "@/lib/supabase/client";

// The signed-in user's own user_roles row (head admin and owner flags); null while
// loading. UX only: the admin RPCs check the live row themselves.
export function useHeadAdmin(): AdminRole | null {
  const [role, setRole] = useState<AdminRole | null>(null);
  useEffect(() => {
    let active = true;
    createClient()
      .auth.getClaims()
      .then(async ({ data }) => {
        const id = data?.claims.sub;
        const r = id ? await fetchAdminRole(id) : null;
        if (active) setRole(r ?? { isAdmin: false, isHead: false, isOwner: false });
      });
    return () => {
      active = false;
    };
  }, []);
  return role;
}
