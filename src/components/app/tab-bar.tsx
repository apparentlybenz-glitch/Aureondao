"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { CandlestickChart, Coins, Timer, UserRound, type LucideIcon } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { AnimatePresence, MotionConfig, motion, useIsPresent, useReducedMotion } from "motion/react";
import { useTranslations } from "next-intl";
import { DURATION, EASE_OUT } from "@/lib/motion";
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
// Nearest to the button first.
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
// Distance from a pill center down to the Trade button center: half a pill, then the 4 px
// the button center sits below the trigger's top edge.
const pillRise = (index: number) => MENU_OFFSET + 22 + 4 + index * PILL_PITCH;

// Trade menu motion. The button and the pills are driven by the open state through the motion
// animate prop, so a tap while they move re-targets from the current value (a spring also keeps
// the velocity) and nothing jumps. Only transform and opacity animate. Tune here.
// Pills fly out from the button: a spring with a little bounce (0.2 at most), staggered.
const PILL_SPRING = { type: "spring", duration: 0.25, bounce: 0.15 } as const;
const PILL_STAGGER = 0.035; // seconds between pills, nearest the button first
const PILL_START_SCALE = 0.9;
// The button twist: no bounce.
const TWIST_SPRING = { type: "spring", duration: DURATION.moderate, bounce: 0 } as const;
const PRESS_SCALE = 0.97;
const EXIT = { duration: DURATION.base, ease: EASE_OUT } as const;
const PRESS = { duration: DURATION.fast, ease: EASE_OUT } as const;

const MotionLink = motion.create(Link);

// One pill. Hidden state: faded and shrunk at the button (reduced motion: faded only, no travel).
// It stays in the tree until its exit finishes (AnimatePresence in TabBar). Navigation is the
// Link's own click and never waits for any of this.
function TradeMenuItem({
  index,
  href,
  Icon,
  label,
  itemRef,
}: {
  index: number;
  href: string;
  Icon: LucideIcon;
  label: string;
  itemRef?: React.Ref<HTMLAnchorElement>;
}) {
  const reduce = useReducedMotion();
  // False while the exit plays: the leaving pill takes no taps.
  const present = useIsPresent();
  const hidden = reduce
    ? { opacity: 0 }
    : { opacity: 0, transform: `translateY(${pillRise(index)}px) scale(${PILL_START_SCALE})` };
  const delay = reduce ? 0 : index * PILL_STAGGER;
  return (
    <DropdownMenu.Item asChild>
      <MotionLink
        ref={itemRef}
        href={href}
        initial={hidden}
        animate={{
          opacity: 1,
          ...(reduce ? null : { transform: "translateY(0px) scale(1)" }),
          transition: {
            opacity: { duration: DURATION.base, ease: EASE_OUT, delay },
            transform: { ...PILL_SPRING, delay },
          },
        }}
        exit={{ ...hidden, transition: EXIT }}
        whileTap={reduce ? undefined : { transform: `translateY(0px) scale(${PRESS_SCALE})`, transition: PRESS }}
        style={present ? undefined : { pointerEvents: "none" }}
        className="flex h-11 min-w-36 items-center gap-2.5 rounded-full bg-secondary px-5 text-sm font-medium text-secondary-foreground shadow-lg outline-none data-[highlighted]:bg-popover"
      >
        <Icon className="size-5 text-primary" />
        {label}
      </MotionLink>
    </DropdownMenu.Item>
  );
}

// The raised Trade button circle. Its twist follows the open state (initial={false}: none on page
// load) and the colors swap on the state class, not in the animation. whileTap is a motion gesture
// on the circle itself, so the trigger's pointerdown preventDefault does not affect it. The explicit
// tabIndex stops motion from making the circle a second focus stop inside the button.
function TradeCircle({ open, Icon }: { open: boolean; Icon: LucideIcon }) {
  const reduce = useReducedMotion();
  const turn = open && !reduce ? 180 : 0; // half a turn while open; none under reduced motion
  return (
    <motion.span
      initial={false}
      animate={{ transform: `rotate(${turn}deg) scale(1)` }}
      whileTap={reduce ? undefined : { transform: `rotate(${turn}deg) scale(${PRESS_SCALE})`, transition: PRESS }}
      transition={TWIST_SPRING}
      tabIndex={-1}
      className={cn(
        "-mt-(--tab-bar-overhang) flex size-14 items-center justify-center rounded-full shadow-lg ring-4 ring-background",
        open ? "bg-foreground text-primary" : "bg-primary text-primary-foreground",
      )}
    >
      <Icon className="size-6" />
    </motion.span>
  );
}

export function TabBar() {
  const t = useTranslations("Shell");
  const pathname = usePathname();
  const isActive = (key: string, href: string) =>
    key === "trade" ? TRADE_ROUTES.some((route) => pathname.startsWith(route)) : pathname.startsWith(href);
  // The page the menu was opened on: it is open only while still there, so any
  // route change (links, browser back) closes it, as the admin drawer does.
  const [openedOn, setOpenedOn] = useState<string | null>(null);
  const open = openedOn === pathname;
  const firstItem = useRef<HTMLAnchorElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // While the menu is open Radix treats a press on the Trade button as an outside press and
  // closes the menu; the click that follows would then reopen it. This flag marks that press so
  // its click is ignored, which makes a second tap on the button close the menu.
  const closedByButtonPress = useRef(false);
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
        className="pointer-events-none fixed inset-0 z-[-1] bg-black/60 opacity-0 transition-opacity duration-(--duration-moderate) ease-out-strong data-[open=true]:opacity-100"
      />
      <ul className="mx-auto grid h-(--tab-bar-h) max-w-[880px] grid-cols-5">
        {TABS.map(({ href, key, Icon }) => {
          const active = isActive(key, href);
          if (key === "trade") {
            return (
              <li key={key}>
                <MotionConfig reducedMotion="user">
                  <DropdownMenu.Root
                    open={open}
                    onOpenChange={(next) => {
                      setOpenedOn(next ? pathname : null);
                      if (next) closedByButtonPress.current = false;
                    }}
                  >
                    <DropdownMenu.Trigger
                      ref={trigger}
                      aria-label={t("tradeMenu")}
                      // Open on click, not pointerdown: the pills spring out from under the finger,
                      // and a pointerup on one would select it. Keyboard opening is Radix's own.
                      // A press that reaches this handler is a fresh one (while the menu is open
                      // Radix blocks the button's own events), so a mouse press that closed the
                      // menu cannot leave its flag set and swallow the next click.
                      onPointerDown={(e) => {
                        closedByButtonPress.current = false;
                        e.preventDefault();
                      }}
                      onClick={() => {
                        if (closedByButtonPress.current) {
                          closedByButtonPress.current = false;
                          return;
                        }
                        setOpenedOn(open ? null : pathname);
                      }}
                      className={cn(
                        "flex h-full w-full flex-col items-center justify-end gap-0.5 pb-2 text-[11px] outline-none",
                        active || open ? "text-primary" : "text-muted-foreground",
                      )}
                    >
                      <TradeCircle open={open} Icon={Icon} />
                      {t(key)}
                    </DropdownMenu.Trigger>
                    {/* Kept mounted through the exit: AnimatePresence holds the menu until the pills
                        finish leaving, and a reopen mid-exit re-targets them from where they are. */}
                    <AnimatePresence>
                      {open ? (
                        <DropdownMenu.Portal forceMount>
                          <DropdownMenu.Content
                            forceMount
                            side="top"
                            align="center"
                            sideOffset={MENU_OFFSET}
                            collisionPadding={8}
                            onInteractOutside={(e) => {
                              // The menu stays mounted while it exits, and its dismiss layer is
                              // still live: a press on the button during the exit (to reopen it)
                              // must not dismiss what it just opened. Read the live state from
                              // the trigger, since AnimatePresence holds the last rendered element.
                              if (trigger.current?.dataset.state !== "open") e.preventDefault();
                            }}
                            onPointerDownOutside={(e) => {
                              const press = e.detail.originalEvent;
                              const box = trigger.current?.getBoundingClientRect();
                              closedByButtonPress.current =
                                trigger.current?.dataset.state === "open" &&
                                !!box &&
                                press.clientX >= box.left &&
                                press.clientX <= box.right &&
                                press.clientY >= box.top &&
                                press.clientY <= box.bottom;
                            }}
                            aria-label={t("tradeMenu")}
                            className="z-50 flex flex-col-reverse gap-3 outline-none"
                          >
                            {TRADE_MENU.map(({ key: itemKey, href: itemHref, Icon: ItemIcon }, i) => (
                              <TradeMenuItem
                                key={itemKey}
                                index={i}
                                href={itemHref}
                                Icon={ItemIcon}
                                label={t(itemKey)}
                                itemRef={i === 0 ? firstItem : undefined}
                              />
                            ))}
                          </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                      ) : null}
                    </AnimatePresence>
                  </DropdownMenu.Root>
                </MotionConfig>
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
