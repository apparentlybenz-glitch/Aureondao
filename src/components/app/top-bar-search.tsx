"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { useTranslations } from "next-intl";

// Submitting opens the Market tab filtered by the text: /market?q=.
export function TopBarSearch({ autoFocus }: { autoFocus?: boolean }) {
  const t = useTranslations("Shell");
  const router = useRouter();
  const [value, setValue] = useState("");

  return (
    <form
      role="search"
      className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-full bg-muted px-3 text-muted-foreground"
      onSubmit={(e) => {
        e.preventDefault();
        const q = value.trim();
        router.push(q ? `/market?q=${encodeURIComponent(q)}` : "/market");
      }}
    >
      <Search className="size-4 shrink-0" />
      <input
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={t("search")}
        aria-label={t("search")}
        enterKeyHint="search"
        autoFocus={autoFocus}
        className="min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground"
      />
    </form>
  );
}
