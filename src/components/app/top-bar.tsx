import Link from "next/link";
import { Bell, Globe, Headset, Search, UserRound } from "lucide-react";
import { useTranslations } from "next-intl";

// App top bar: avatar, search, language, notifications, support. Search,
// notifications and support open "Coming soon" screens until their slices land.
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
      <Link
        href="/market"
        className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-full bg-muted px-3 text-sm text-muted-foreground"
      >
        <Search className="size-4 shrink-0" />
        <span className="truncate">{t("search")}</span>
      </Link>
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
