"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

// The signed-in user's starred markets (RLS limits every query to their rows).
// Toggling is optimistic and rolls back if the write fails.
export function useFavorites() {
  const [ids, setIds] = useState<ReadonlySet<string> | null>(null);

  useEffect(() => {
    let active = true;
    const supabase = createClient();
    supabase
      .from("user_favorites")
      .select("market_id")
      .then(({ data }) => {
        if (active) setIds(new Set((data ?? []).map((r: { market_id: string }) => r.market_id)));
      });
    return () => {
      active = false;
    };
  }, []);

  const toggle = useCallback(
    async (marketId: string) => {
      if (!ids) return;
      const supabase = createClient();
      const { data: session } = await supabase.auth.getSession();
      const uid = session.session?.user.id;
      if (!uid) return;
      const adding = !ids.has(marketId);
      const apply = (add: boolean) =>
        setIds((prev) => {
          const next = new Set(prev ?? []);
          if (add) next.add(marketId);
          else next.delete(marketId);
          return next;
        });
      apply(adding);
      const { error } = adding
        ? await supabase.from("user_favorites").insert({ user_id: uid, market_id: marketId })
        : await supabase.from("user_favorites").delete().eq("user_id", uid).eq("market_id", marketId);
      if (error) apply(!adding);
    },
    [ids],
  );

  return { favorites: ids, toggle };
}
