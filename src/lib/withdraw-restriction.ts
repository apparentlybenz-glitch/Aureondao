"use client";

import { useEffect, useState } from "react";
import { onVisible } from "@/lib/on-visible";
import { createClient } from "@/lib/supabase/client";

// Whether the signed-in user's Withdraw page is restricted (profiles.withdraw_restricted_at,
// own row under profiles_select). Null while loading or when the read failed. Reloads when
// the tab becomes visible; profiles is not in the Realtime publication.
export function useWithdrawRestricted(): boolean | null {
  const [restricted, setRestricted] = useState<boolean | null>(null);

  useEffect(() => {
    const supabase = createClient();
    let active = true;
    const load = async () => {
      const { data: session } = await supabase.auth.getSession();
      const uid = session.session?.user.id;
      if (!uid) return;
      const { data, error } = await supabase
        .from("profiles")
        .select("withdraw_restricted_at")
        .eq("id", uid)
        .maybeSingle()
        .overrideTypes<{ withdraw_restricted_at: string | null }, { merge: false }>();
      if (!active || error || !data) return;
      setRestricted(data.withdraw_restricted_at !== null);
    };
    void load();
    const stopVisible = onVisible(() => void load());
    return () => {
      active = false;
      stopVisible();
    };
  }, []);

  return restricted;
}
