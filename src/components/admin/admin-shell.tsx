"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Ban, House, IdCard, LifeBuoy, Menu, ScrollText, ShieldCheck, Timer, Users, Wallet, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useTranslations } from "next-intl";
import { SelectedUserProvider } from "@/components/admin/selected-user";
import { useAccount } from "@/lib/use-account";
import { useHeadAdmin } from "@/lib/use-head-admin";
import { cn } from "@/lib/utils";

// Every admin section, in drawer order. A new section is one entry here plus its
// route and its `Admin.sections` string. Admin access is listed for head admins only.
const SECTIONS = [
  { key: "search", href: "/admin", Icon: Users },
  { key: "topUp", href: "/admin/top-up", Icon: Wallet },
  { key: "restrictions", href: "/admin/restrictions", Icon: Ban },
  { key: "kyc", href: "/admin/kyc", Icon: IdCard },
  { key: "optionPeriods", href: "/admin/option-periods", Icon: Timer },
  { key: "support", href: "/admin/support", Icon: LifeBuoy },
  { key: "auditLog", href: "/admin/audit-log", Icon: ScrollText },
  { key: "adminAccess", href: "/admin/admin-access", Icon: ShieldCheck },
] as const;

const linkClass = "flex h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium";

// Gate, then a bar under the top bar whose hamburger opens the section list in a
// drawer from the left, at every width. This gate is for nav visibility: the admin
// layout already redirects a non-admin on the server. The data boundary is in SQL:
// RLS admin reads and every admin RPC require the live admin row (no second
// factor, docs/decisions.md C21).
export function AdminShell({ children }: { children: React.ReactNode }) {
  const t = useTranslations("Admin");
  const c = useTranslations("Common");
  const pathname = usePathname();
  const { ready, isAdmin } = useAccount();
  const isHead = useHeadAdmin();
  // The page the drawer was opened on: it is open only while still there, so a
  // route change closes it.
  const [openedOn, setOpenedOn] = useState<string | null>(null);
  const close = () => setOpenedOn(null);

  if (!ready) return <p className="text-sm">{c("loading")}</p>;
  if (!isAdmin) return <p className="text-sm text-muted-foreground">{t("needAdmin")}</p>;

  const current = SECTIONS.find((s) => s.href === pathname) ?? SECTIONS[0];

  return (
    <SelectedUserProvider>
      <div className="sticky top-[calc(var(--top-bar-h)+var(--safe-t))] z-20 -mx-4 -mt-4 mb-4 flex h-12 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur">
        <Dialog.Root open={openedOn === pathname} onOpenChange={(next) => setOpenedOn(next ? pathname : null)}>
          <Dialog.Trigger
            aria-label={t("openMenu")}
            className="-ml-2 flex size-9 items-center justify-center rounded-full text-muted-foreground"
          >
            <Menu className="size-5" />
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
            <Dialog.Content
              aria-describedby={undefined}
              className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col gap-3 border-r bg-background px-3 pt-[calc(0.5rem+var(--safe-t))] pb-[calc(1rem+var(--safe-b))]"
            >
              <div className="flex items-center justify-between pl-3">
                <Dialog.Title className="text-base font-semibold">{t("title")}</Dialog.Title>
                <Dialog.Close aria-label={t("close")} className="flex size-9 items-center justify-center rounded-full">
                  <X className="size-5" />
                </Dialog.Close>
              </div>
              <nav aria-label={t("navLabel")} className="flex flex-1 flex-col justify-between gap-3">
                <ul className="space-y-1">
                  {SECTIONS.filter((s) => s.key !== "adminAccess" || isHead === true).map(({ key, href, Icon }) => {
                    const active = pathname === href;
                    return (
                      <li key={key}>
                        <Link
                          href={href}
                          onClick={close}
                          aria-current={active ? "page" : undefined}
                          className={cn(linkClass, active ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted")}
                        >
                          <Icon className="size-4" />
                          {t(`sections.${key}`)}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
                <Link href="/home" className={cn(linkClass, "border-t text-muted-foreground hover:bg-muted")}>
                  <House className="size-4" />
                  {t("backToApp")}
                </Link>
              </nav>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
        <p className="text-sm font-semibold">{t(`sections.${current.key}`)}</p>
      </div>

      <div className="space-y-5">{children}</div>
    </SelectedUserProvider>
  );
}
