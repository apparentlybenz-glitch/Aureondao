"use client";

import Link from "next/link";
import { DropdownMenu } from "radix-ui";
import { UserRound } from "lucide-react";
import { useTranslations } from "next-intl";
import { useSignOut } from "@/components/app/sign-out-button";
import { useAccount } from "@/lib/use-account";

const item =
  "flex h-11 w-full cursor-default items-center rounded-md px-3 text-sm outline-none select-none data-[highlighted]:bg-muted";
const divider = "my-1 h-px bg-border";

// The one account entry point: the top bar avatar opens this menu. Admin shows
// only for an admin session; /admin and the admin RPCs enforce the role themselves.
export function AccountMenu({ align = "start" }: { align?: "start" | "end" }) {
  const t = useTranslations("Shell");
  const c = useTranslations("Common");
  const { email, isAdmin } = useAccount();
  const signOut = useSignOut();

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        aria-label={t("account")}
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted"
      >
        <UserRound className="size-5" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align={align}
          sideOffset={8}
          collisionPadding={8}
          className="z-50 w-64 max-w-[calc(100vw-1rem)] rounded-lg border bg-popover p-1 shadow-lg"
        >
          <DropdownMenu.Label className="truncate px-3 py-2 text-xs text-muted-foreground">
            {email ?? "--"}
          </DropdownMenu.Label>
          <DropdownMenu.Separator className={divider} />
          {isAdmin && (
            <DropdownMenu.Item asChild className={item}>
              <Link href="/admin">{t("menu.admin")}</Link>
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Item asChild className={item}>
            <Link href="/account/profile">{t("menu.profile")}</Link>
          </DropdownMenu.Item>
          <DropdownMenu.Item asChild className={item}>
            <Link href="/account/security">{t("menu.security")}</Link>
          </DropdownMenu.Item>
          <DropdownMenu.Separator className={divider} />
          <DropdownMenu.Item asChild className={item}>
            <Link href="/terms">{t("menu.legal")}</Link>
          </DropdownMenu.Item>
          <DropdownMenu.Separator className={divider} />
          <DropdownMenu.Item className={item} onSelect={signOut}>
            {c("signOut")}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
