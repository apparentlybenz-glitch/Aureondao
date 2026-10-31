import Link from "next/link";
import { useTranslations } from "next-intl";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function CtaBanner() {
  const t = useTranslations("Landing.cta");
  return (
    <section className="rounded-3xl border bg-card px-6 py-12 text-center md:py-16">
      <h2 className="mx-auto max-w-2xl text-2xl font-semibold tracking-tight text-balance md:text-3xl">{t("title")}</h2>
      <p className="mx-auto mt-3 max-w-xl text-sm text-muted-foreground md:text-base">{t("body")}</p>
      <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
        <Link href="/sign-up" className={cn(buttonVariants(), "h-11 w-full px-5 text-base sm:w-auto")}>
          {t("createAccount")}
        </Link>
        <Link href="/sign-in" className={cn(buttonVariants({ variant: "outline" }), "h-11 w-full px-5 text-base sm:w-auto")}>
          {t("logIn")}
        </Link>
      </div>
    </section>
  );
}
