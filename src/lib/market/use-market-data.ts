"use client";

import { useSyncExternalStore } from "react";
import * as Sentry from "@sentry/nextjs";
import { loadMarkets } from "./load-markets";
import { createMarketStore } from "./store";
import type { Snapshot } from "./store";

const SERVER_SNAPSHOT: Snapshot = { markets: null, tickers: {}, source: null, failing: false, now: 0 };

// One store per browser tab: every table reads it, none polls on its own.
let store: ReturnType<typeof createMarketStore> | null = null;

function getStore() {
  store ??= createMarketStore({
    loadMarkets,
    fetch: (url, init) => fetch(url, init),
    report: (error) => Sentry.captureException(error),
    isHidden: () => document.visibilityState === "hidden",
    watchVisibility: (cb) => {
      document.addEventListener("visibilitychange", cb);
      return () => document.removeEventListener("visibilitychange", cb);
    },
    random: Math.random,
  });
  return store;
}

// Module-level so React sees the same functions on every render. An inline
// subscribe would resubscribe each render, and every resubscribe polls at once.
const subscribe = (listener: () => void) => getStore().subscribe(listener);
const getSnapshot = () => getStore().getSnapshot();
const getServerSnapshot = () => SERVER_SNAPSHOT;

export function useMarketData(): Snapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
