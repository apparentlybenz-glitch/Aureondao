import { useTranslations } from "next-intl";
import type { SupportStatus } from "@/lib/support";
import { cn } from "@/lib/utils";

const TONE: Record<SupportStatus, string> = {
  open: "bg-foreground/15 text-foreground",
  answered: "bg-primary/15 text-primary",
  closed: "bg-muted text-muted-foreground",
};

export function SupportStatusBadge({ status }: { status: SupportStatus }) {
  const t = useTranslations("Support");
  return (
    <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold", TONE[status])}>
      {t(`status.${status}`)}
    </span>
  );
}
