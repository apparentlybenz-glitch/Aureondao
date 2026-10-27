"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Ban, IdCard, Menu, ScrollText, Timer, Users, Wallet, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useTranslations } from "next-intl";
import { SelectedUserProvider } from "@/components/admin/selected-user";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

const SECTIONS = [
  { key: "search", href: "/admin", Icon: Users },
  { key: "topUp", href: "/admin/top-up", Icon: Wallet },
  { key: "restrictions", href: "/admin/restrictions", Icon: Ban },
  { key: "kyc", href: "/admin/kyc", Icon: IdCard },
  { key: "optionPeriods", href: "/admin/option-periods", Icon: Timer },
  { key: "auditLog", href: "/admin/audit-log", Icon: ScrollText },
] as const;

// UX gate only. The real boundary is in SQL: RLS admin reads and every admin RPC
// require the admin row and aal2.
type Gate = "loading" | "not_admin" | "step_up" | "needs_factor" | "ok";

function useAdminGate(): Gate {
  const [gate, setGate] = useState<Gate>("loading");
  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getClaims().then(async ({ data }) => {
      const claims = data?.claims;
      if (claims?.user_role !== "admin") return setGate("not_admin");
      if (claims.aal === "aal2") return setGate("ok");
      const { data: factors } = await supabase.auth.mfa.listFactors();
      setGate(factors?.totp.some((f) => f.status === "verified") ? "step_up" : "needs_factor");
    });
  }, []);
  return gate;
}

function StepUp({ hasFactor, here }: { hasFactor: boolean; here: string }) {
  const t = useTranslations("Admin");
  return (
    <div className="space-y-3 rounded-xl border bg-card p-4">
      <p className="font-medium">{t("stepUpTitle")}</p>
      <p className="text-sm text-muted-foreground">{hasFactor ? t("stepUpBody") : t("setUpTotp")}</p>
      {hasFactor ? (
        <Button asChild className="h-11 w-full">
          <Link href={`/sign-in/mfa?next=${encodeURIComponent(here)}`}>{t("stepUp")}</Link>
        </Button>
      ) : null}
      <Button asChild variant={hasFactor ? "secondary" : "default"} className="h-11 w-full">
        <Link href="/account/security">{t("toSecurity")}</Link>
      </Button>
    </div>
  );
}

function NavLinks({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  const t = useTranslations("Admin");
  return (
    <nav aria-label={t("navLabel")}>
      <ul className="space-y-1">
        {SECTIONS.map(({ key, href, Icon }) => {
          const active = pathname === href;
          return (
            <li key={key}>
              <Link
                href={href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium",
                  active ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted",
                )}
              >
                <Icon className="size-4" />
                {t(`sections.${key}`)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// Gate, then the section navigation: a sidebar from md:, and on a phone a bar
// under the top bar whose hamburger opens the same list in a drawer from the left.
export function AdminShell({ children }: { children: React.ReactNode }) {
  const t = useTranslations("Admin");
  const c = useTranslations("Common");
  const pathname = usePathname();
  const gate = useAdminGate();
  const [open, setOpen] = useState(false);

  if (gate === "loading") return <p className="text-sm">{c("loading")}</p>;
  if (gate === "not_admin") return <p className="text-sm text-muted-foreground">{t("needAdmin")}</p>;
  if (gate !== "ok") return <StepUp hasFactor={gate === "step_up"} here={pathname} />;

  const current = SECTIONS.find((s) => s.href === pathname) ?? SECTIONS[0];

  return (
    <SelectedUserProvider>
      <div className="sticky top-[calc(var(--top-bar-h)+var(--safe-t))] z-20 -mx-4 -mt-4 mb-4 flex h-12 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur md:hidden">
        <Dialog.Root open={open} onOpenChange={setOpen}>
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
              <NavLinks pathname={pathname} onNavigate={() => setOpen(false)} />
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
        <p className="text-sm font-semibold">{t(`sections.${current.key}`)}</p>
      </div>

      <div className="md:grid md:grid-cols-[13rem_minmax(0,1fr)] md:gap-6">
        <aside className="hidden md:block">
          <div className="sticky top-[calc(var(--top-bar-h)+var(--safe-t)+1rem)] space-y-3">
            <p className="px-3 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{t("title")}</p>
            <NavLinks pathname={pathname} />
          </div>
        </aside>
        <div className="min-w-0 space-y-5">{children}</div>
      </div>
    </SelectedUserProvider>
  );
}
