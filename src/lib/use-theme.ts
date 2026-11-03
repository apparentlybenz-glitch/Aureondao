"use client";

import { useSyncExternalStore } from "react";
import { currentTheme, type Theme } from "@/lib/theme";

// Follows the class on <html> (set before paint by THEME_SCRIPT, changed by applyTheme), so a
// reader is right after hydration and in every component when the theme is toggled.
function subscribe(notify: () => void) {
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

export function useTheme(): Theme {
  return useSyncExternalStore<Theme>(subscribe, currentTheme, () => "dark");
}
