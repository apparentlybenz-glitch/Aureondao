"use client";

import { useEffect, useState } from "react";
import { onVisible } from "@/lib/on-visible";
import { createClient } from "@/lib/supabase/client";

export type Suspension = { suspended: boolean; reason: string | null };

// The signed-in user's own suspension state (profiles_select allows the own row).
// Reloads when the tab becomes visible; profiles is not in the Realtime publication.
export function useSuspension(): Suspension | null {
  const [state, setState] = useState<Suspension | null>(null);

  useEffect(() => {
    const supabase = createClient();
    let active = true;
    const load = async () => {
      const { data: session } = await supabase.auth.getSession();
      const uid = session.session?.user.id;
      if (!uid) return;
      const { data, error } = await supabase
        .from("profiles")
        .select("suspended_at, suspension_reason")
        .eq("id", uid)
        .maybeSingle()
        .overrideTypes<{ suspended_at: string | null; suspension_reason: string | null }, { merge: false }>();
      if (!active || error || !data) return;
      setState({ suspended: data.suspended_at !== null, reason: data.suspension_reason });
    };
    void load();
    const stopVisible = onVisible(() => void load());
    return () => {
      active = false;
      stopVisible();
    };
  }, []);

  return state;
}
