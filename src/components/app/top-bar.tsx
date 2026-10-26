import Link from "next/link";
import { Bell, Globe, Headset, UserRound } from "lucide-react";
import { useTranslations } from "next-intl";
import { TopBarSearch } from "@/components/app/top-bar-search";

// App top bar: avatar, search, language, notifications, support. Search opens
// the Market tab (/market?q=); notifications and support open "Coming soon".
export function TopBar() {
  const t = useTranslations("Shell");
  const icon = "flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground";
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 bg-background/95 px-4 pt-[env(safe-area-inset-top)] backdrop-blur">
      <Link href="/account" aria-label={t("account")} className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
        <UserRound className="size-5" />
      </Link>
      <span className="shrink-0 rounded-full bg-amber-500 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-black">
        {t("virtualPill")}
      </span>
      <TopBarSearch />
      <button type="button" disabled aria-label={t("language")} title={t("language")} className={icon}>
        <Globe className="size-5" />
      </button>
      <Link href="/notifications" aria-label={t("notifications")} className={icon}>
        <Bell className="size-5" />
      </Link>
      <Link href="/support" aria-label={t("support")} className={icon}>
        <Headset className="size-5" />
      </Link>
    </header>
  );
}
