"use client";

import { useEffect, useState } from "react";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/client";

// phone is read only so that update_profile, which always writes it, can pass the
// stored value back unchanged; no screen shows it.
export type OwnProfile = { uid: string; email: string | null; nickname: string; phone: string | null };
export type ProfileError = { code?: string; message: string };

export const PROFILE_SELECT = "uid::text, email, nickname, phone";

// The user sees a generic message for an unmapped error, so the real one goes to Sentry.
export function reportProfileError(step: "load" | "save", error: ProfileError) {
  Sentry.captureException(new Error(`profile ${step} failed: ${error.code ?? "no code"} ${error.message}`), {
    tags: { source: "account-profile" },
  });
}

// The signed-in user's own profiles row, read by id: an admin's RLS read covers every
// profile, so an unfiltered single() would fail with PGRST116 for them.
export function useOwnProfile() {
  const [profile, setProfile] = useState<OwnProfile | null>(null);
  const [error, setError] = useState<ProfileError | null>(null);

  useEffect(() => {
    let active = true;
    const supabase = createClient();
    void (async () => {
      const { data: session } = await supabase.auth.getSession();
      const id = session.session?.user.id;
      if (!active) return;
      if (!id) return setError({ message: "No session" });
      const { data, error } = await supabase.from("profiles").select(PROFILE_SELECT).eq("id", id).single<OwnProfile>();
      if (!active) return;
      if (error) {
        reportProfileError("load", error);
        setError(error);
      } else setProfile(data);
    })();
    return () => {
      active = false;
    };
  }, []);

  return { profile, setProfile, error, setError };
}
