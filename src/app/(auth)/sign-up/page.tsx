"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Field, FormError } from "@/components/auth/field";
import { useAuthMessage } from "@/components/auth/use-auth-message";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";

export default function SignUpPage() {
  const t = useTranslations("Auth");
  const authMessage = useAuthMessage();
  const c = useTranslations("Common");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email"));
    const nickname = String(form.get("nickname") ?? "").trim();
    const { data, error } = await createClient().auth.signUp({
      email,
      password: String(form.get("password")),
      options: {
        // The signup trigger reads raw_user_meta_data.nickname.
        data: nickname ? { nickname } : {},
        emailRedirectTo: `${window.location.origin}/auth/confirm`,
      },
    });
    setPending(false);
    if (error) {
      setError(authMessage(error));
      return;
    }
    // With email confirmation off, signUp returns a session right away.
    if (data.session) router.replace("/home");
    else setSentTo(email);
  }

  if (sentTo) {
    return (
      <div className="space-y-2">
        <h1 className="text-lg font-semibold">{t("checkEmailTitle")}</h1>
        <p className="text-sm text-muted-foreground">{t("checkEmailBody", { email: sentTo })}</p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <h1 className="text-lg font-semibold">{t("signUpTitle")}</h1>
      <Field id="email" type="email" label={c("email")} autoComplete="email" required />
      <Field id="password" type="password" label={c("password")} autoComplete="new-password" required />
      <Field id="nickname" label={t("nickname")} maxLength={32} autoComplete="nickname" />
      <FormError message={error} />
      <Button type="submit" className="h-10 w-full" disabled={pending}>
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
