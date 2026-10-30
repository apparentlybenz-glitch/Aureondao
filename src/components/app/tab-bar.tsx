"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { CandlestickChart, Coins, Timer, UserRound } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useTranslations } from "next-intl";
import { NAV_ITEMS } from "@/lib/nav";
import { cn } from "@/lib/utils";

// Fixed bottom tab bar, mobile only (below md; the desktop top bar replaces it):
// --tab-bar-h plus the bottom safe area. Pages reserve the same space with the
// pb-tabbar padding below md. Five tabs from NAV_ITEMS plus Profile; Options and
// Forex are reached through the Trade menu (Spot is the Trade tab's own route).
const TAB_KEYS = ["home", "market", "trade", "assets"];
const TABS = [
  ...NAV_ITEMS.filter((item) => TAB_KEYS.includes(item.key)),
  { href: "/account", key: "profile", Icon: UserRound } as const,
];
const hrefOf = (key: string) => NAV_ITEMS.find((item) => item.key === key)?.href ?? "/home";
// Nearest to the button first. --dy is the distance from a pill center down to the button center.
const TRADE_MENU = [
  { key: "spot", href: hrefOf("trade"), Icon: CandlestickChart },
  { key: "forex", href: hrefOf("forex"), Icon: Coins },
  { key: "options", href: hrefOf("options"), Icon: Timer },
] as const;
const TRADE_ROUTES = TRADE_MENU.map((item) => item.href);
// Pill height 44 plus a 12 px gap. The button circle rises 24 px (--tab-bar-overhang) above
// the trigger, so the stack starts that far plus a gap above the trigger's top edge.
const PILL_PITCH = 56;
const MENU_OFFSET = 24 + 12;

export function TabBar() {
  const t = useTranslations("Shell");
  const pathname = usePathname();
  const isActive = (key: string, href: string) =>
    key === "trade" ? TRADE_ROUTES.some((route) => pathname.startsWith(route)) : pathname.startsWith(href);
  // The page the menu was opened on: it is open only while still there, so any
  // route change (links, browser back) closes it, as the admin drawer does.
  const [openedOn, setOpenedOn] = useState<string | null>(null);
  const open = openedOn === pathname;
  const [picked, setPicked] = useState<string | null>(null);
  // The close twist runs only after a first open, never on page load.
  const [wasOpened, setWasOpened] = useState(false);
  const firstItem = useRef<HTMLAnchorElement>(null);
  // Focus moves to the first pill on open; Radix returns it to the button on close.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => firstItem.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  return (
    <nav data-tab-bar className="fixed inset-x-0 bottom-0 z-40 border-t bg-background pb-(--safe-b) md:hidden">
      <div
        aria-hidden
        data-open={open}
        className="pointer-events-none fixed inset-0 z-[-1] bg-black/60 opacity-0 transition-opacity duration-200 data-[open=true]:opacity-100"
      />
      <ul className="mx-auto grid h-(--tab-bar-h) max-w-[880px] grid-cols-5">
        {TABS.map(({ href, key, Icon }) => {
          const active = isActive(key, href);
          if (key === "trade") {
            return (
              <li key={key}>
                <DropdownMenu.Root
                  open={open}
                  onOpenChange={(next) => {
                    setOpenedOn(next ? pathname : null);
                    if (next) {
                      setPicked(null);
                      setWasOpened(true);
                    }
                  }}
                >
                  <DropdownMenu.Trigger
                    aria-label={t("tradeMenu")}
                    // Open on click, not pointerdown: the pills spring out from under the finger,
                    // and a pointerup on one would select it. Keyboard opening is Radix's own.
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setOpenedOn(open ? null : pathname);
                      if (!open) {
                        setPicked(null);
                        setWasOpened(true);
                      }
                    }}
                    className={cn(
                      "flex h-full w-full flex-col items-center justify-end gap-0.5 pb-2 text-[11px] outline-none",
                      active || open ? "text-primary" : "text-muted-foreground",
                    )}
                  >
                    <span
                      className={cn(
                        "-mt-(--tab-bar-overhang) flex size-14 items-center justify-center rounded-full shadow-lg ring-4 ring-background",
                        open ? "trade-twist-open bg-foreground text-primary" : "bg-primary text-primary-foreground",
                        !open && wasOpened && "trade-twist-close",
                      )}
                    >
                      <Icon className="size-6" />
                    </span>
                    {t(key)}
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      side="top"
                      align="center"
                      sideOffset={MENU_OFFSET}
                      collisionPadding={8}
                      aria-label={t("tradeMenu")}
                      className="trade-menu z-50 flex flex-col-reverse gap-3 outline-none"
                    >
                      {TRADE_MENU.map(({ key: itemKey, href: itemHref, Icon: ItemIcon }, i) => (
                        <DropdownMenu.Item
                          key={itemKey}
                          asChild
                          onSelect={() => setPicked(itemKey)}
                        >
                          <Link
                            ref={i === 0 ? firstItem : undefined}
                            href={itemHref}
                            data-picked={picked === itemKey ? "" : undefined}
                            data-other={picked !== null && picked !== itemKey ? "" : undefined}
                            style={{ "--i": i, "--dy": `${MENU_OFFSET + 22 + 4 + i * PILL_PITCH}px` } as React.CSSProperties}
                            className="trade-item flex h-11 min-w-36 items-center gap-2.5 rounded-full bg-secondary px-5 text-sm font-medium text-secondary-foreground shadow-lg outline-none data-[highlighted]:bg-popover"
                          >
                            <ItemIcon className="size-5 text-primary" />
                            {t(itemKey)}
                          </Link>
                        </DropdownMenu.Item>
                      ))}
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
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
