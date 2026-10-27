"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

const TABS = [
  { key: "profile", href: "/account" },
  { key: "verification", href: "/account/verification" },
  { key: "security", href: "/account/security" },
] as const;

// Profile, Verification and Security. Hidden inside the verification flow,
// which has its own header and stepper.
export function AccountTabs() {
  const t = useTranslations("Account");
  const pathname = usePathname();
  if (!TABS.some((tab) => tab.href === pathname)) return null;
  return (
    <nav aria-label={t("tabsLabel")} className="-mx-4 mb-5 border-b px-4">
      <ul className="flex gap-6">
        {TABS.map(({ key, href }) => {
          const active = pathname === href;
          return (
            <li key={key}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "-mb-px flex h-11 items-center border-b-2 text-sm font-medium",
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
