import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

// False in the prerendered HTML and until React has hydrated, then true. Auth
// forms disable their submit button on it: a prerendered form is clickable
// before its onSubmit exists, and a native submit would put the fields in the
// address bar. A disabled default button also blocks Enter in a field.
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
