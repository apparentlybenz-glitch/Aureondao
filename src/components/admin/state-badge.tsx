import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

export function StateBadge({ suspended }: { suspended: boolean }) {
  const t = useTranslations("Admin");
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold",
        suspended ? "bg-destructive/15 text-destructive" : "bg-primary/15 text-primary",
      )}
    >
      {suspended ? t("suspended") : t("active")}
    </span>
  );
}
