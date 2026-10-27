"use client";

import { useTranslations } from "next-intl";
import { authErrorKey } from "@/lib/auth-error";

// Maps a Supabase Auth error to user copy by its code. error.message is never
// shown: it is upstream English text.
export function useAuthMessage() {
  const errors = useTranslations("AuthErrors");
  const common = useTranslations("Common");
  return (error: { code?: string; name?: string; status?: number }): string => {
    const key = authErrorKey(error);
    return key ? errors(key) : common("genericError");
  };
}
