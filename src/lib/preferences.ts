"use client";

import { useEffect, useSyncExternalStore } from "react";
import { onVisible } from "@/lib/on-visible";
import { createClient } from "@/lib/supabase/client";

// The confirmTrades preference, stored per account in profiles.confirm_trades (read under
// profiles_select, written only through set_confirm_trades). One module store shared by
// every reader. value is null until loaded; readers treat null as on, the safe side.
export type ConfirmTradesState = { value: boolean | null; failed: boolean };

const INITIAL: ConfirmTradesState = { value: null, failed: false };
let state = INITIAL;
let uid: string | null = null;
// Latest wins: a load or save that started later makes an earlier load's result stale.
let ticket = 0;
const listeners = new Set<() => void>();

function set(next: ConfirmTradesState) {
  state = next;
  listeners.forEach((notify) => notify());
}

async function load() {
  const mine = ++ticket;
  const supabase = createClient();
  const { data: session } = await supabase.auth.getSession();
  const own = session.session?.user.id ?? null;
  if (mine !== ticket) return;
  if (own !== uid) {
    // Another account signed in on this tab: never show the previous account's value.
    uid = own;
    set({ value: null, failed: false });
  }
  if (!own) return;
  const { data, error } = await supabase
    .from("profiles")
    .select("confirm_trades")
    .eq("id", own)
    .maybeSingle()
    .overrideTypes<{ confirm_trades: boolean }, { merge: false }>();
  if (mine !== ticket) return;
  set(error || !data ? { value: state.value, failed: true } : { value: data.confirm_trades, failed: false });
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
}

// Loads on mount and whenever the tab becomes visible (profiles is not in Realtime).
export function useConfirmTrades(): ConfirmTradesState {
  useEffect(() => {
    void load();
    return onVisible(() => void load());
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => INITIAL,
  );
}

// Shows the new value at once and puts the old one back if the server refuses it.
// Returns the RPC error, or null on success.
export async function saveConfirmTrades(value: boolean): Promise<{ code?: string; message: string } | null> {
  const previous = state;
  ticket++;
  set({ value, failed: false });
  const { error } = await createClient().rpc("set_confirm_trades", { p_value: value });
  if (error) {
    set(previous);
    return error;
  }
  return null;
}
