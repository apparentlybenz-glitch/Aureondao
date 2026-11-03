"use client";

import { Moon, Sun } from "lucide-react";
import { useTranslations } from "next-intl";
import { applyTheme } from "@/lib/theme";
import { useTheme } from "@/lib/use-theme";
import { cn } from "@/lib/utils";

// The one theme switcher: a sun while dark, a moon while light. One tap toggles.
export function ThemeSwitcher({ className }: { className?: string }) {
  const t = useTranslations("Shell");
  const theme = useTheme();
  const label = theme === "dark" ? t("themeToLight") : t("themeToDark");
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => applyTheme(theme === "dark" ? "light" : "dark")}
      className={cn("flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground", className)}
    >
      {theme === "dark" ? <Sun className="size-5" /> : <Moon className="size-5" />}
    </button>
  );
}
