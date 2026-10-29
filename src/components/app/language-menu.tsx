"use client";

import { DropdownMenu } from "radix-ui";
import { Check, Globe } from "lucide-react";
import { useTranslations } from "next-intl";

// The app is English only (src/i18n/request.ts), so the menu has one entry,
// selected. A second language adds a RadioItem here.
export function LanguageMenu({ className }: { className?: string }) {
  const t = useTranslations("Shell");
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger aria-label={t("language")} title={t("language")} className={className}>
        <Globe className="size-5" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={8}
          collisionPadding={8}
          className="z-50 w-40 rounded-lg border bg-popover p-1 shadow-lg"
        >
          <DropdownMenu.RadioGroup value="en">
            <DropdownMenu.RadioItem
              value="en"
              className="flex h-11 w-full cursor-default items-center justify-between rounded-md px-3 text-sm outline-none select-none data-[highlighted]:bg-muted"
            >
              {t("languageEnglish")}
              <DropdownMenu.ItemIndicator>
                <Check className="size-4 text-primary" />
              </DropdownMenu.ItemIndicator>
            </DropdownMenu.RadioItem>
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
