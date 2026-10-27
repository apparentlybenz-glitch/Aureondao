import Link from "next/link";
import { useTranslations } from "next-intl";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function NotFound() {
  const t = useTranslations("Pages");
  return (
    <main className="flex min-h-dvh flex-1 flex-col items-center justify-center gap-3 px-4 py-10 text-center">
      <p className="text-sm font-medium text-muted-foreground">404</p>
      <h1 className="text-xl font-semibold">{t("notFoundTitle")}</h1>
      <p className="max-w-xs text-sm text-muted-foreground">{t("notFoundBody")}</p>
      <Link href="/" className={cn(buttonVariants(), "mt-2 h-10 px-4")}>
        {t("home")}
      </Link>
    </main>
  );
}
