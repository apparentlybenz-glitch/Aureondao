import Link from "next/link";
import { Globe, Headset } from "lucide-react";
import { useTranslations } from "next-intl";
import { AccountMenu } from "@/components/app/account-menu";
import { TopBarSearch } from "@/components/app/top-bar-search";

// App top bar: account menu, search, language, support. Search opens the Market
// tab (/market?q=); support opens "Coming soon".
export function TopBar() {
  const t = useTranslations("Shell");
  const icon = "flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground";
  return (
    <header className="sticky top-0 z-30 flex h-[calc(var(--top-bar-h)+var(--safe-t))] items-center gap-2 bg-background/95 px-4 pt-(--safe-t) backdrop-blur">
      <AccountMenu />
      <span className="shrink-0 rounded-full bg-amber-500 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-black">
        {t("virtualPill")}
      </span>
      <TopBarSearch />
      <button type="button" disabled aria-label={t("language")} title={t("language")} className={icon}>
        <Globe className="size-5" />
      </button>
      <Link href="/support" aria-label={t("support")} className={icon}>
        <Headset className="size-5" />
      </Link>
    </header>
  );
}
