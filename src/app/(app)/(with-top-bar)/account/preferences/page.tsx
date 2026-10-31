"use client";

import { useTranslations } from "next-intl";
import { savePref, usePref } from "@/lib/preferences";
import { cn } from "@/lib/utils";

// Per-browser preferences (src/lib/preferences.ts).
export default function PreferencesPage() {
  const t = useTranslations("Preferences");
  const confirmTrades = usePref("confirmTrades");

  return (
    <section className="rounded-xl border p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <h2 id="pref-confirm-trades" className="font-medium">
            {t("confirmTrades")}
          </h2>
          <p id="pref-confirm-trades-desc" className="text-sm text-muted-foreground">
            {t("confirmTradesDescription")}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={confirmTrades}
          aria-labelledby="pref-confirm-trades"
          aria-describedby="pref-confirm-trades-desc"
          onClick={() => savePref("confirmTrades", !confirmTrades)}
          className={cn(
            "relative h-6 w-11 shrink-0 rounded-full transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
            confirmTrades ? "bg-primary" : "bg-muted",
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 left-0.5 size-5 rounded-full bg-white transition-transform",
              confirmTrades ? "translate-x-5" : "",
            )}
          />
        </button>
      </div>
    </section>
  );
}
