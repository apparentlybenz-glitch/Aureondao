"use client";

import { useEffect, useRef, useState } from "react";
import { startPolling } from "./poller";
import type { PollState } from "./poller";

const watchVisibility = (cb: () => void) => {
  document.addEventListener("visibilitychange", cb);
  return () => document.removeEventListener("visibilitychange", cb);
};
const isHidden = () => document.visibilityState === "hidden";

// Runs `load` while the page is visible, restarting whenever `key` changes
// (a new symbol or interval). A null key stops it. State from an older key is
// never shown for a newer one.
export function usePoll<T>(key: string | null, load: () => Promise<T>, delayMs: () => number): PollState<T> {
  const [state, setState] = useState<PollState<T> & { key: string | null }>({ key: null, data: null, failing: false });
  const loadRef = useRef(load);
  const delayRef = useRef(delayMs);
  useEffect(() => {
    loadRef.current = load;
    delayRef.current = delayMs;
  });

  useEffect(() => {
    if (key === null) return;
    return startPolling<T>({
      load: () => loadRef.current(),
      delayMs: () => delayRef.current(),
      isHidden,
      watchVisibility,
      onChange: (next) => setState({ key, ...next }),
    });
  }, [key]);

  return state.key === key ? state : { data: null, failing: false };
}
