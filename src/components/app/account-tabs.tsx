"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

const TABS = [
  { key: "overview", href: "/account" },
  { key: "profile", href: "/account/profile" },
  { key: "security", href: "/account/security" },
  { key: "verification", href: "/account/verification" },
  { key: "preferences", href: "/account/preferences" },
] as const;

// Overview, Profile, Security, Verification and Preferences at every width. The row
// scrolls sideways on narrow screens instead of wrapping. Hidden inside the
// verification flow, which has its own header and stepper.
export function AccountTabs() {
  const t = useTranslations("Account");
  const pathname = usePathname();
  if (!TABS.some((tab) => tab.href === pathname)) return null;
  return (
    <nav aria-label={t("tabsLabel")} className="-mx-4 mb-5 overflow-x-auto px-4 shadow-[inset_0_-1px_0_var(--color-border)] [scrollbar-width:none]">
      <ul className="flex w-max gap-6">
        {TABS.map(({ key, href }) => {
          const active = pathname === href;
          return (
            <li key={key}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-11 items-center border-b-2 text-sm font-medium whitespace-nowrap",
                  active ? "border-primary text-foreground" : "border-transparent text-muted-foreground",
                )}
              >
                {t(`tabs.${key}`)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
