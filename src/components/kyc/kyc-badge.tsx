import { useTranslations } from "next-intl";
import type { KycState } from "@/lib/kyc";
import { cn } from "@/lib/utils";

const TONE: Record<KycState, string> = {
  none: "bg-muted text-muted-foreground",
  pending: "bg-amber-500/15 text-amber-500",
  approved: "bg-primary/15 text-primary",
  rejected: "bg-destructive/15 text-destructive",
};

export function KycBadge({ state, className }: { state: KycState; className?: string }) {
  const t = useTranslations("Kyc");
  return (
    <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold", TONE[state], className)}>
      {t(`badge.${state}`)}
    </span>
  );
}
