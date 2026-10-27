"use client";

import { useEffect } from "react";

// Registers /sw.js (the offline shell) in production builds only, so dev and
// preview-of-dev never cache anything.
export function RegisterServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      // No offline shell this visit; the app works the same without it.
    });
  }, []);
  return null;
}
