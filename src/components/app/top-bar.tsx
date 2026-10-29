import Link from "next/link";
import { Headset } from "lucide-react";
import { useTranslations } from "next-intl";
import { AccountMenu } from "@/components/app/account-menu";
import { LanguageMenu } from "@/components/app/language-menu";
import { TopBarSearch } from "@/components/app/top-bar-search";

// Mobile top bar (below md; the desktop nav replaces it): account menu, search,
// language, support. Search opens the Market tab (/market?q=).
export function TopBar() {
  const t = useTranslations("Shell");
  const icon = "flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground";
  return (
    <header className="sticky top-0 z-30 flex h-[calc(var(--top-bar-h)+var(--safe-t))] items-center gap-2 bg-background/95 px-4 pt-(--safe-t) backdrop-blur md:hidden">
      <AccountMenu />
      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold tracking-wide text-muted-foreground">
        {t("virtualPill")}
      </span>
      <TopBarSearch />
      <LanguageMenu className={icon} />
      <Link href="/support" aria-label={t("support")} className={icon}>
        <Headset className="size-5" />
      </Link>
    </header>
  );
}
