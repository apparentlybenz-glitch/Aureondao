"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";

// Users with a verified factor must step up to AAL2. Reads the local session
// (no network call) and sends AAL1 sessions to the challenge page.
export function SessionGuard() {
  const router = useRouter();
  useEffect(() => {
    createClient()
      .auth.mfa.getAuthenticatorAssuranceLevel()
      .then(({ data }) => {
        if (data?.nextLevel === "aal2" && data.currentLevel !== "aal2") {
          const here = window.location.pathname + window.location.search;
          router.replace(`/sign-in/mfa?next=${encodeURIComponent(here)}`);
        }
      });
  }, [router]);
  return null;
}
