"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

// Route error boundary: the app shell and theme stay in place around it.
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("Pages");
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <main className="flex min-h-dvh flex-1 flex-col items-center justify-center gap-3 px-4 py-10 text-center">
      <h1 className="text-xl font-semibold">{t("errorTitle")}</h1>
      <p className="max-w-xs text-sm text-muted-foreground">{t("errorBody")}</p>
      <Button type="button" onClick={reset} className="mt-2 h-10 px-4">
        {t("retry")}
      </Button>
    </main>
  );
}
