"use client";

import { useRef } from "react";

// One idempotency key per confirm attempt. Retrying the same attempt (same
// inputs, after a failure where the server may not have answered) reuses its
// key, so the RPC returns the first result instead of moving money twice.
// Changed inputs or a settled attempt get a new key.
export function useAttemptKey() {
  const attempt = useRef<{ key: string; inputs: string } | null>(null);
  return {
    keyFor(inputs: string): string {
      if (attempt.current?.inputs !== inputs) {
        attempt.current = { key: crypto.randomUUID(), inputs };
      }
      return attempt.current.key;
    },
    settle() {
      attempt.current = null;
    },
  };
}
