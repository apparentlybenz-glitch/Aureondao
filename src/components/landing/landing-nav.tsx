import Link from "next/link";
import { useTranslations } from "next-intl";
import { BrandMark } from "@/components/brand/brand-mark";
import { Wordmark } from "@/components/brand/wordmark";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function LandingNav() {
  const t = useTranslations("Landing.nav");
  return (
    <header className="border-b">
      <nav aria-label={t("label")} className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-2 px-4">
        <Link href="/" className="flex shrink-0 items-center gap-2" aria-label="AureonX">
          <BrandMark variant="small" idPrefix="nav" className="size-8" />
          <Wordmark className="h-4 w-auto" />
        </Link>
        <div className="flex items-center gap-1">
          <Link href="/sign-in" className={cn(buttonVariants({ variant: "ghost" }), "h-9 px-3")}>
            {t("logIn")}
          </Link>
          <Link href="/sign-up" className={cn(buttonVariants(), "h-9 px-3")}>
            {t("createAccount")}
          </Link>
        </div>
      </nav>
    </header>
  );
}
