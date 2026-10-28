"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useTranslations } from "next-intl";
import { Field, FormError } from "@/components/auth/field";
import { useAuthMessage } from "@/components/auth/use-auth-message";
import { Button } from "@/components/ui/button";
import { safeNext } from "@/lib/safe-next";
import { createClient } from "@/lib/supabase/client";
import { useHydrated } from "@/lib/use-hydrated";

export default function SignInPage() {
  const t = useTranslations("Auth");
  const c = useTranslations("Common");
  const router = useRouter();
  const authMessage = useAuthMessage();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const hydrated = useHydrated();

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({
      email: String(form.get("email")),
      password: String(form.get("password")),
    });
    if (error) {
      setError(authMessage(error));
      setPending(false);
      return;
    }
    const next = safeNext(new URLSearchParams(window.location.search).get("next"));
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal?.nextLevel === "aal2" && aal.currentLevel !== "aal2") {
      router.replace(`/sign-in/mfa?next=${encodeURIComponent(next)}`);
    } else {
      router.replace(next);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <h1 className="text-lg font-semibold">{t("signInTitle")}</h1>
      <Field id="email" type="email" label={c("email")} autoComplete="email" required />
      <Field id="password" type="password" label={c("password")} autoComplete="current-password" required />
      <Suspense>
        <LinkError />
      </Suspense>
      <FormError message={error} />
      <Button type="submit" className="h-10 w-full" disabled={pending || !hydrated}>
        {pending ? c("loading") : t("signInSubmit")}
      </Button>
      <div className="flex justify-between text-sm">
        <Link href="/forgot-password" className="text-muted-foreground hover:underline">
          {t("forgotPassword")}
        </Link>
        <span>
          {t("noAccount")}{" "}
          <Link href="/sign-up" className="underline">
            {t("toSignUp")}
          </Link>
        </span>
      </div>
    </form>
  );
}

// Shown when /auth/confirm or /auth/callback bounced an invalid link here.
// useSearchParams inside Suspense keeps the page a static prerender.
function LinkError() {
  const t = useTranslations("Auth");
  const error = useSearchParams().get("error");
  return <FormError message={error === "link" ? t("linkInvalid") : null} />;
}
