"use client";

import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import { X } from "lucide-react";
import { Toast } from "radix-ui";
import { useTranslations } from "next-intl";
import { dismissToast, getServerToasts, getToasts, subscribeToasts } from "@/lib/notify";

// Renders the notify() queue with Radix Toast, above the tab bar and the raised
// Trade button on mobile. Each toast closes after 6 s, on swipe or on its close button.
export function Toaster() {
  const t = useTranslations("Common");
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getServerToasts);
  // A closed toast stays in the queue until its exit animation ends (Radix keeps the node mounted
  // for it); the timer is a fallback so a missed animationend never strands it.
  const [closing, setClosing] = useState<ReadonlySet<number>>(new Set());
  return (
    <Toast.Provider duration={6000} swipeDirection="down">
      {toasts.map((toast) => (
        <Toast.Root
          key={toast.id}
          open={!closing.has(toast.id)}
          onOpenChange={(open) => {
            if (open) return;
            setClosing((prev) => new Set(prev).add(toast.id));
            setTimeout(() => dismissToast(toast.id), 400);
          }}
          onAnimationEnd={(e) => {
            if (e.currentTarget.dataset.state === "closed") dismissToast(toast.id);
          }}
          className="toast flex items-start gap-3 rounded-xl border bg-popover p-3 text-popover-foreground shadow-lg"
        >
          <div className="min-w-0 flex-1 space-y-0.5">
            <Toast.Title className="text-sm font-semibold">{toast.title}</Toast.Title>
            {toast.description ? (
              <Toast.Description className="truncate text-sm text-muted-foreground">{toast.description}</Toast.Description>
            ) : null}
            {toast.href ? (
              <Toast.Action asChild altText={t("view")}>
                <Link href={toast.href} className="text-sm font-medium text-primary">
                  {t("view")}
                </Link>
              </Toast.Action>
            ) : null}
          </div>
          <Toast.Close aria-label={t("close")} className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground">
            <X className="size-4" />
          </Toast.Close>
        </Toast.Root>
      ))}
      <Toast.Viewport className="fixed inset-x-0 bottom-[calc(var(--tab-bar-h)+var(--tab-bar-overhang)+var(--safe-b)+0.5rem)] md:bottom-4 z-[100] mx-auto flex w-full max-w-[420px] flex-col gap-2 px-4 outline-none" />
    </Toast.Provider>
  );
}
