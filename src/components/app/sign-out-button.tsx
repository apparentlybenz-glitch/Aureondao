"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";

export function useSignOut() {
  const router = useRouter();
  return async () => {
    await createClient().auth.signOut();
    router.replace("/sign-in");
  };
}

export function SignOutButton() {
  const t = useTranslations("Common");
  const signOut = useSignOut();
  return (
    <Button variant="ghost" size="sm" onClick={signOut}>
      {t("signOut")}
    </Button>
  );
}
