"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { holdSplash } from "@/lib/splash";
import { createClient } from "@/lib/supabase/client";

// Users with a verified factor must step up to AAL2. Reads the local session
// (no network call) and sends AAL1 sessions to the challenge page. The launch splash waits for
// this check (holdSplash).
export function SessionGuard() {
  const router = useRouter();
  useEffect(() => {
    const release = holdSplash();
    createClient()
      .auth.mfa.getAuthenticatorAssuranceLevel()
      .then(({ data }) => {
        if (data?.nextLevel === "aal2" && data.currentLevel !== "aal2") {
          const here = window.location.pathname + window.location.search;
          router.replace(`/sign-in/mfa?next=${encodeURIComponent(here)}`);
        }
      })
      .finally(release);
    return release;
  }, [router]);
  return null;
}
