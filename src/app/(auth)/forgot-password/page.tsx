"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Field, FormError } from "@/components/auth/field";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";

export default function ForgotPasswordPage() {
  const t = useTranslations("Auth");
  const c = useTranslations("Common");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const email = String(new FormData(e.currentTarget).get("email"));
    const { error } = await createClient().auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/confirm`,
    });
    setPending(false);
    if (error) setError(error.message);
    else setSentTo(email);
  }

  if (sentTo) {
    return <p className="text-sm">{t("forgotSent", { email: sentTo })}</p>;
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <h1 className="text-lg font-semibold">{t("forgotTitle")}</h1>
      <Field id="email" type="email" label={c("email")} autoComplete="email" required />
      <FormError message={error} />
      <Button type="submit" className="h-10 w-full" disabled={pending}>
        {pending ? c("loading") : t("forgotSubmit")}
      </Button>
    </form>
  );
}
