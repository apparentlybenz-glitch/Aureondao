"use client";

import { Eye, EyeOff } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// A password input with a show or hide button inside the field. Any other
// props go to the input. The button never takes focus, so the caret and the
// mobile keyboard stay where they are.
export function PasswordInput({
  className,
  ...props
}: Omit<React.ComponentProps<typeof Input>, "type">) {
  const c = useTranslations("Common");
  const [shown, setShown] = useState(false);
  const label = shown ? c("hidePassword") : c("showPassword");
  const Icon = shown ? EyeOff : Eye;

  return (
    <div className="relative">
      <Input {...props} type={shown ? "text" : "password"} className={cn(className, "pr-12")} />
      <button
        type="button"
        aria-label={label}
        aria-pressed={shown}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setShown((v) => !v)}
        className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-lg text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:text-primary focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <Icon className="size-5" aria-hidden="true" />
      </button>
    </div>
  );
}
