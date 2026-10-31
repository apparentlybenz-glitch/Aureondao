"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Headset, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { AccountMenu } from "@/components/app/account-menu";
import { LanguageMenu } from "@/components/app/language-menu";
import { TopBarSearch } from "@/components/app/top-bar-search";
import { BrandMark } from "@/components/brand/brand-mark";
import { Wordmark } from "@/components/brand/wordmark";
import { NAV_ITEMS } from "@/lib/nav";
import { useAccount } from "@/lib/use-account";
import { cn } from "@/lib/utils";

// Desktop top bar (md and up), on every (app) page including Spot and Options.
// Below md the bottom tab bar and the mobile top bar are used instead.
export function DesktopNav() {
  const t = useTranslations("Shell");
  const pathname = usePathname();
  const { isAdmin } = useAccount();
  const [searching, setSearching] = useState(false);
  const icon = "flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground";

  return (
    <header className="sticky top-0 z-30 hidden h-(--top-bar-h) items-center gap-6 border-b bg-sidebar px-6 md:flex">
      <Link href="/home" aria-label="AureonX" className="flex shrink-0 items-center gap-2">
        <BrandMark variant="small" idPrefix="desktop-nav" className="size-7" />
        <Wordmark className="h-3.5 w-auto" />
      </Link>
      <nav aria-label={t("mainNav")} className="flex items-center gap-1">
        {NAV_ITEMS.map((item) => {
          const { href, key } = item;
          const active = pathname.startsWith(href);
          return (
            <Link
              key={key}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium",
                active ? "text-primary" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t("desktopKey" in item ? item.desktopKey : key)}
            </Link>
          );
        })}
        {isAdmin && (
          <Link
            href="/admin"
            aria-current={pathname.startsWith("/admin") ? "page" : undefined}
            className="rounded-md px-3 py-1.5 text-sm font-bold text-orange-500"
          >
            {t("menu.admin")}
          </Link>
        )}
      </nav>
      <div className="ml-auto flex items-center gap-1">
        <span className="mr-2 shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold tracking-wide text-muted-foreground">
          {t("virtualPill")}
        </span>
        {searching ? (
          <div
            className="w-64"
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget)) setSearching(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setSearching(false);
            }}
          >
            <TopBarSearch autoFocus />
          </div>
        ) : (
          <button type="button" aria-label={t("searchOpen")} onClick={() => setSearching(true)} className={icon}>
            <Search className="size-5" />
          </button>
        )}
        <LanguageMenu className={icon} />
        <Link href="/support" aria-label={t("support")} className={icon}>
          <Headset className="size-5" />
        </Link>
        <AccountMenu align="end" />
      </div>
    </header>
  );
}
