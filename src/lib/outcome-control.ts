import { createClient } from "@/lib/supabase/client";

export const OUTCOME_MODES = ["market", "force_win", "force_loss", "controlled"] as const;
export type OutcomeMode = (typeof OUTCOME_MODES)[number];

export type OutcomeConfig = { mode: OutcomeMode; winRatePct: number };
export type OutcomeOverride = { userId: string; email: string | null; mode: OutcomeMode; winRatePct: number };

type ConfigRow = { mode: OutcomeMode; win_rate_pct: number };
type OverrideRow = {
  user_id: string;
  mode: OutcomeMode;
  win_rate_pct: number;
  profiles: { email: string | null } | null;
};

// The global Options outcome row. Admins read it under RLS.
export async function loadOutcomeConfig(): Promise<OutcomeConfig | null> {
  const { data, error } = await createClient()
    .from("outcome_config")
    .select("mode, win_rate_pct")
    .eq("id", 1)
    .maybeSingle()
    .overrideTypes<ConfigRow, { merge: false }>();
  return error || !data ? null : { mode: data.mode, winRatePct: data.win_rate_pct };
}

// Every per-user override, newest first, with the profile email.
export async function loadOutcomeOverrides(): Promise<OutcomeOverride[] | null> {
  const { data, error } = await createClient()
    .from("outcome_overrides")
    .select("user_id, mode, win_rate_pct, profiles(email)")
    .order("updated_at", { ascending: false })
    .overrideTypes<OverrideRow[], { merge: false }>();
  if (error) return null;
  return data.map((r) => ({
    userId: r.user_id,
    email: r.profiles?.email ?? null,
    mode: r.mode,
    winRatePct: r.win_rate_pct,
  }));
}
