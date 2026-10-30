"use client";

import { useCallback, useSyncExternalStore } from "react";

// Tailwind's lg breakpoint. A layout that mounts a different tree per breakpoint
// uses this so only one copy of a polling panel exists at a time.
export const LG = "(min-width: 64rem)";

// False in the prerendered HTML and until hydration, then follows the media query.
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
