"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRpcMessage } from "@/components/app/use-rpc-message";
import { FormError } from "@/components/auth/field";
import { saveConfirmTrades, useConfirmTrades } from "@/lib/preferences";
import { cn } from "@/lib/utils";

// Account preferences (profiles.confirm_trades, src/lib/preferences.ts).
export default function PreferencesPage() {
  const t = useTranslations("Preferences");
  const c = useTranslations("Common");
  const rpcMessage = useRpcMessage();
  const { value, failed } = useConfirmTrades();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Until the account value loads the switch shows the default (on) and is disabled.
  const on = value ?? true;

  async function toggle() {
    setPending(true);
    setError(null);
    const rpcError = await saveConfirmTrades(!on);
    setPending(false);
    if (rpcError) setError(rpcMessage(rpcError));
  }

  return (
    <section className="space-y-3 rounded-xl border p-4">
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
          aria-checked={on}
          aria-labelledby="pref-confirm-trades"
          aria-describedby="pref-confirm-trades-desc"
          disabled={value === null || pending}
          onClick={() => void toggle()}
          className={cn(
            "relative h-6 w-11 shrink-0 rounded-full transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60",
            on ? "bg-primary" : "bg-muted",
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 left-0.5 size-5 rounded-full bg-white transition-transform motion-reduce:transition-none",
              on ? "translate-x-5" : "",
            )}
          />
        </button>
      </div>
      <FormError message={error ?? (failed && value === null ? c("genericError") : null)} />
    </section>
  );
}
