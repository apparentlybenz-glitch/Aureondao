"use client";

import { useSyncExternalStore } from "react";

// Per-browser preferences, one JSON object in localStorage. Storage can throw (private
// windows, blocked site data), so every access is guarded and falls back to the default.
const KEY = "aureonx.prefs";

export type Prefs = {
  // Show the trade confirmation dialog before a Spot or Options order is sent.
  confirmTrades: boolean;
};

export const DEFAULT_PREFS: Prefs = { confirmTrades: true };

const listeners = new Set<() => void>();

function readAll(): Partial<Prefs> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Partial<Prefs>) : {};
  } catch {
    return {};
  }
}

export function readPref<K extends keyof Prefs>(name: K): Prefs[K] {
  const value = readAll()[name];
  return typeof value === typeof DEFAULT_PREFS[name] ? (value as Prefs[K]) : DEFAULT_PREFS[name];
}

export function savePref<K extends keyof Prefs>(name: K, value: Prefs[K]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...readAll(), [name]: value }));
  } catch {
    // Not saved; the default applies next time.
  }
  listeners.forEach((notify) => notify());
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  window.addEventListener("storage", notify);
  return () => {
    listeners.delete(notify);
    window.removeEventListener("storage", notify);
  };
}

// For rendering a preference: the default on the server and during hydration, then the stored value.
export function usePref<K extends keyof Prefs>(name: K): Prefs[K] {
  return useSyncExternalStore(
    subscribe,
    () => readPref(name),
    () => DEFAULT_PREFS[name],
  );
}
