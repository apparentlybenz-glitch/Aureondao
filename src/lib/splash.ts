// Readiness for the launch splash (splash.tsx). A component whose work the splash should wait for
// (the app shell's session check) takes a hold on mount and releases it when done; the splash
// leaves once hydration is done and no hold is left, or at its 900 ms cap, whichever comes first.
let holds = 0;
const listeners = new Set<() => void>();

export function holdSplash(): () => void {
  holds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
    listeners.forEach((listener) => listener());
  };
}

// Calls onReady once no hold is left (at once if none is). Returns an unsubscribe.
export function whenSplashReady(onReady: () => void): () => void {
  if (holds === 0) {
    onReady();
    return () => {};
  }
  const listener = () => {
    if (holds > 0) return;
    listeners.delete(listener);
    onReady();
  };
  listeners.add(listener);
  return () => listeners.delete(listener);
}
