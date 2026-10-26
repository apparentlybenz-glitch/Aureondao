"use client";

import { useEffect, useSyncExternalStore } from "react";
import { createClient } from "@/lib/supabase/client";

// Server-time clock for countdowns. Expiry is server time (expires_at), so the
// countdown uses Date.now() plus an offset measured with server_time(). One
// shared one-second ticker runs while any component subscribes.
let offsetMs = 0;
let now = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function tick() {
  now = Date.now() + offsetMs;
  for (const listener of listeners) listener();
}

// Module-level so React sees the same functions on every render.
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (!timer) {
    tick();
    timer = setInterval(tick, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
};
const getSnapshot = () => now;
const getServerSnapshot = () => 0;

// Server time in epoch ms, updated once a second (0 before the first tick).
export function useServerNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

// Measures the offset on mount and whenever the page becomes visible again,
// taking the midpoint of the request as the moment the server read its clock.
export function useServerClockSync() {
  useEffect(() => {
    const supabase = createClient();
    let active = true;
    const sync = async () => {
      const sent = Date.now();
      const { data, error } = await supabase.rpc("server_time");
      const received = Date.now();
      const server = typeof data === "string" ? Date.parse(data) : Number.NaN;
      if (!active || error || Number.isNaN(server)) return;
      offsetMs = server - (sent + received) / 2;
      tick();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void sync();
    };
    void sync();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
}
