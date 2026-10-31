"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { centsFromText, ZERO_CENTS } from "@/lib/money";
import { onVisible } from "@/lib/on-visible";
import { createClient } from "@/lib/supabase/client";

export const ACCOUNTS = ["capital", "spot", "forex", "options"] as const;
export type Account = (typeof ACCOUNTS)[number];

export type Wallet = { account: Account; available: bigint; held: bigint };

type WalletRow = { account: Account; available_cents: string; held_cents: string };

export const WALLET_SELECT = "account, available_cents::text, held_cents::text";

export function toWallets(rows: WalletRow[]): Wallet[] {
  return rows
    .map((r) => ({
      account: r.account,
      available: centsFromText(r.available_cents),
      held: centsFromText(r.held_cents),
    }))
    .sort((a, b) => ACCOUNTS.indexOf(a.account) - ACCOUNTS.indexOf(b.account));
}

export function totalCents(wallets: Wallet[]): bigint {
  return wallets.reduce((sum, w) => sum + w.available + w.held, ZERO_CENTS);
}

// The signed-in user's 4 wallets, kept live through Realtime. The channel name
// gets a random suffix per mount (hard rule 7). reload is latest-wins: one
// money RPC can emit several wallet events, so overlapping reloads are common
// and only the newest one may write state.
export function useWallets() {
  const [wallets, setWallets] = useState<Wallet[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const latest = useRef(0);

  const reload = useCallback(async () => {
    const ticket = ++latest.current;
    const supabase = createClient();
    const { data: session } = await supabase.auth.getSession();
    const uid = session.session?.user.id;
    if (!uid) return;
    const { data, error } = await supabase
      .from("wallets")
      .select(WALLET_SELECT)
      .eq("user_id", uid)
      .overrideTypes<WalletRow[], { merge: false }>();
    if (ticket !== latest.current) return;
    if (error) setError(error.message);
    else setWallets(toWallets(data));
  }, []);

  useEffect(() => {
    const supabase = createClient();
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      const uid = data.session?.user.id;
      if (!uid || !active) return;
      void reload();
      channel = supabase
        .channel(`wallets:${crypto.randomUUID()}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "wallets", filter: `user_id=eq.${uid}` },
          () => void reload(),
        )
        // Realtime does not replay missed changes, so every (re)subscribe and
        // every return to the tab reloads.
        .subscribe((status) => {
          if (status === "SUBSCRIBED") void reload();
        });
    });
    const stopVisible = onVisible(() => void reload());
    return () => {
      active = false;
      stopVisible();
      if (channel) void supabase.removeChannel(channel);
    };
  }, [reload]);

  return { wallets, error, reload };
}
