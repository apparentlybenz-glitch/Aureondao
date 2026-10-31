"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

// Copies value; the label reads Copied for 2 s. iconOnly keeps it to the icon with label as its name.
export function CopyButton({ value, label, iconOnly = false }: { value: string; label: string; iconOnly?: boolean }) {
  const t = useTranslations("Account");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <Button
      type="button"
      variant={iconOnly ? "ghost" : "secondary"}
      size={iconOnly ? "icon-xs" : "sm"}
      aria-label={label}
      onClick={() => {
        navigator.clipboard?.writeText(value).then(
          () => setCopied(true),
          () => {},
        );
      }}
    >
      {copied ? <Check className="text-primary" /> : <Copy />}
      {iconOnly ? null : copied ? t("copied") : t("copy")}
    </Button>
  );
}
