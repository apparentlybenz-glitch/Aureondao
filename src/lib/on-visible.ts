// Calls `cb` each time the page becomes visible again. Returns the unsubscribe.
export function onVisible(cb: () => void): () => void {
  const handler = () => {
    if (document.visibilityState === "visible") cb();
  };
  document.addEventListener("visibilitychange", handler);
  return () => document.removeEventListener("visibilitychange", handler);
}
