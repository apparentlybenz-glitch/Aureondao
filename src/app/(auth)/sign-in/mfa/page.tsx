"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Field, FormError } from "@/components/auth/field";
import { Button } from "@/components/ui/button";
import { safeNext } from "@/lib/safe-next";
import { createClient } from "@/lib/supabase/client";

// AAL1 -> AAL2 step-up with the user's verified TOTP factor.
export default function MfaPage() {
  const t = useTranslations("Auth");
  const c = useTranslations("Common");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const code = String(new FormData(e.currentTarget).get("code")).trim();
    const supabase = createClient();
    const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
    const factor = factors?.totp[0];
    if (listError || !factor) {
      setError(listError?.message ?? c("genericError"));
      setPending(false);
      return;
    }
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
    if (error) {
      setError(error.message);
      setPending(false);
      return;
    }
    router.replace(safeNext(new URLSearchParams(window.location.search).get("next")));
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <h1 className="text-lg font-semibold">{t("mfaTitle")}</h1>
      <p className="text-sm text-muted-foreground">{t("mfaBody")}</p>
      <Field
        id="code"
        label={t("mfaCode")}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        maxLength={6}
        required
      />
      <FormError message={error} />
      <Button type="submit" className="h-10 w-full" disabled={pending}>
        {pending ? c("loading") : t("mfaSubmit")}
      </Button>
    </form>
  );
}
