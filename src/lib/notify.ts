// The one way to show a toast. The Toaster in the (app) layout renders the queue.
export type ToastItem = { id: number; title: string; description?: string; href?: string };

const MAX = 3;
const EMPTY: ToastItem[] = [];
let toasts: ToastItem[] = EMPTY;
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function notify(toast: Omit<ToastItem, "id">) {
  toasts = [...toasts, { ...toast, id: nextId++ }].slice(-MAX);
  emit();
}

export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const getToasts = () => toasts;
export const getServerToasts = () => EMPTY;
