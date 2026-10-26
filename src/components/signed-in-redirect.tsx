"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";

// Public pages stay static and outside the proxy. A signed-in visitor is sent
// on by reading the local session (no network call).
export function SignedInRedirect({ to }: { to: string }) {
  const router = useRouter();
  useEffect(() => {
    createClient()
      .auth.getSession()
      .then(({ data }) => {
        if (data.session) router.replace(to);
      });
  }, [router, to]);
  return null;
}
