"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export type Account = { ready: boolean; email: string | null; isAdmin: boolean };

// Email and role from the local session claims (no network call). UX only: the
// real admin boundary is RLS and the admin RPCs, which read the live admin row.
export function useAccount(): Account {
  const [account, setAccount] = useState<Account>({ ready: false, email: null, isAdmin: false });
  useEffect(() => {
    createClient()
      .auth.getClaims()
      .then(({ data }) => {
        const claims = data?.claims;
        setAccount({
          ready: true,
          email: typeof claims?.email === "string" ? claims.email : null,
          isAdmin: claims?.user_role === "admin",
        });
      });
  }, []);
  return account;
}
