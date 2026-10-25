"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Field, FormError } from "@/components/auth/field";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";

// Reached from the recovery link: /auth/confirm has already set the session.
export default function UpdatePasswordPage() {
  const t = useTranslations("Auth");
  const c = useTranslations("Common");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const password = String(new FormData(e.currentTarget).get("password"));
    const { error } = await createClient().auth.updateUser({ password });
    setPending(false);
    if (error) setError(error.message);
    else router.replace("/account");
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <h1 className="text-lg font-semibold">{t("updatePasswordTitle")}</h1>
      <Field id="password" type="password" label={t("newPassword")} autoComplete="new-password" required />
      <FormError message={error} />
      <Button type="submit" className="h-10 w-full" disabled={pending}>
        {pending ? c("loading") : t("updatePasswordSubmit")}
      </Button>
    </form>
  );
}
