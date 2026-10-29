"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeftRight, ChartCandlestick, House, Timer, Wallet } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

// Fixed bottom tab bar: --tab-bar-h plus the bottom safe area. Pages reserve the same
// space with the pb-tabbar padding in the (app) layout. Trade opens Spot (O24 ★).
const TABS = [
  { href: "/home", key: "home", Icon: House },
  { href: "/market", key: "market", Icon: ChartCandlestick },
  { href: "/spot", key: "trade", Icon: ArrowLeftRight },
  { href: "/options", key: "options", Icon: Timer },
  { href: "/assets", key: "assets", Icon: Wallet },
] as const;

export function TabBar() {
  const t = useTranslations("Shell");
  const pathname = usePathname();
  const isActive = (href: string) => pathname.startsWith(href);

  return (
    <nav data-tab-bar className="fixed inset-x-0 bottom-0 z-40 border-t bg-background pb-(--safe-b)">
      <ul className="mx-auto grid h-(--tab-bar-h) max-w-[880px] grid-cols-5">
        {TABS.map(({ href, key, Icon }) => {
          const active = isActive(href);
          if (key === "trade") {
            return (
              <li key={key}>
                <Link
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex h-full flex-col items-center justify-end gap-0.5 pb-2 text-[11px]",
                    active ? "text-primary" : "text-muted-foreground",
                  )}
                >
                  <span className="-mt-(--tab-bar-overhang) flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg ring-4 ring-background">
                    <Icon className="size-6" />
                  </span>
                  {t(key)}
                </Link>
              </li>
            );
          }
          return (
            <li key={key}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-full flex-col items-center justify-center gap-0.5 text-[11px]",
                  active ? "text-primary" : "text-muted-foreground",
                )}
              >
                <Icon className="size-5" />
                {t(key)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
