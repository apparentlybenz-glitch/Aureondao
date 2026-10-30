"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Field, FormError } from "@/components/auth/field";
import { useAuthMessage } from "@/components/auth/use-auth-message";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { useHydrated } from "@/lib/use-hydrated";

export default function SignUpPage() {
  const t = useTranslations("Auth");
  const authMessage = useAuthMessage();
  const c = useTranslations("Common");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const hydrated = useHydrated();

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    const password = String(form.get("password"));
    if (password !== String(form.get("confirm-password"))) {
      setError(t("passwordMismatch"));
      return;
    }
    if (!form.get("terms")) {
      setError(t("termsRequired"));
      return;
    }
    setPending(true);
    const { data, error } = await createClient().auth.signUp({
      email: String(form.get("email")),
      password,
    });
    setPending(false);
    if (error) {
      setError(authMessage(error));
      return;
    }
    // No session means the project still requires email confirmation.
    if (data.session) router.replace("/home");
    else setError(c("genericError"));
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <h1 className="text-lg font-semibold">{t("signUpTitle")}</h1>
      <Field id="email" type="email" label={c("email")} autoComplete="email" required />
      <Field id="password" type="password" label={c("password")} autoComplete="new-password" required />
      <Field
        id="confirm-password"
        type="password"
        label={t("confirmPassword")}
        autoComplete="new-password"
        required
      />
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="terms" required className="mt-0.5 size-4 shrink-0 accent-primary" />
        <span>
          {t.rich("termsLabel", {
            terms: (chunks) => (
              <Link href="/terms" target="_blank" rel="noopener noreferrer" className="underline">
                {chunks}
              </Link>
            ),
            privacy: (chunks) => (
              <Link href="/privacy" target="_blank" rel="noopener noreferrer" className="underline">
                {chunks}
              </Link>
            ),
          })}
        </span>
      </label>
      <FormError message={error} />
      <Button type="submit" className="h-10 w-full" disabled={pending || !hydrated}>
        {pending ? c("loading") : t("signUpSubmit")}
      </Button>
      <p className="text-center text-sm">
        {t("haveAccount")}{" "}
        <Link href="/sign-in" className="underline">
          {t("toSignIn")}
        </Link>
      </p>
    </form>
  );
}
