"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

const STORAGE_KEY = "aureonx-cookie-consent";

export type CookieChoice = "accept" | "decline";

// The stored choice, or null when none is stored (or storage is unavailable).
// Nothing is gated on it today: no optional script exists.
export function getCookieConsent(): CookieChoice | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const choice = (JSON.parse(raw) as { choice?: unknown }).choice;
    return choice === "accept" || choice === "decline" ? choice : null;
  } catch {
    return null;
  }
}

// useSyncExternalStore reads storage on the client only: the server and the
// hydration pass render nothing, so a returning visitor sees no flash.
const listeners = new Set<() => void>();
let dismissed = false;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function saveChoice(choice: CookieChoice) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ choice, at: new Date().toISOString() }));
  } catch {
    // Storage blocked: the card closes for this visit and returns on the next.
  }
  dismissed = true;
  listeners.forEach((listener) => listener());
}

const shouldAsk = () => !dismissed && getCookieConsent() === null;
const hasTabBar = () => document.querySelector("[data-tab-bar]") !== null;

export function CookieConsent() {
  const t = useTranslations("CookieConsent");
  usePathname(); // re-render on navigation so the tab bar check stays current
  const open = useSyncExternalStore(subscribe, shouldAsk, () => false);
  const aboveTabBar = useSyncExternalStore(subscribe, hasTabBar, () => false);

  if (!open) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 z-50 px-4"
      style={{
        bottom: aboveTabBar
          ? "calc(var(--tab-bar-h) + var(--tab-bar-overhang) + 0.5rem + var(--safe-b))"
          : "calc(0.75rem + var(--safe-b))",
      }}
    >
      <div
        role="dialog"
        aria-label={t("label")}
        className="pointer-events-auto mx-auto max-w-md space-y-3 rounded-xl border border-primary/40 bg-background p-4 shadow-lg"
      >
        <h2 className="text-sm font-semibold">{t("heading")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("bodyBefore")}
          <Link href="/privacy" className="text-primary underline-offset-4 hover:underline">
            {t("privacyLink")}
          </Link>
          {t("bodyAfter")}
        </p>
        <div className="flex gap-3">
          <Button variant="outline" className="h-10 flex-1 border-primary" onClick={() => saveChoice("accept")}>
            {t("accept")}
          </Button>
          <Button variant="outline" className="h-10 flex-1 border-primary" onClick={() => saveChoice("decline")}>
            {t("decline")}
          </Button>
        </div>
      </div>
    </div>
  );
}
