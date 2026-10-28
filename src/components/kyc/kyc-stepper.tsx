import { Check } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

export const KYC_STEPS = ["country", "personal", "documents", "review"] as const;

// Four stops. `done` steps show a check; `current` (the flow only) is ringed.
// Compact hides the labels and names the current step above the dots instead.
export function KycStepper({ done, current, compact = false }: { done: number; current?: number; compact?: boolean }) {
  const t = useTranslations("Kyc");
  return (
    <div className="space-y-2">
      {compact && current !== undefined ? (
        <p className="text-xs text-muted-foreground">
          {t("stepOf", { step: current + 1, total: KYC_STEPS.length })}
          <span aria-hidden="true"> · </span>
          <span className="font-medium text-foreground">{t(`steps.${KYC_STEPS[current]}`)}</span>
        </p>
      ) : null}
      <ol aria-label={t("stepperLabel")} className="flex items-start">
        {KYC_STEPS.map((step, i) => {
          const isDone = i < done;
          const isCurrent = i === current;
          const label = t(`steps.${step}`);
          return (
            <li
              key={step}
              aria-current={isCurrent ? "step" : undefined}
              className="relative flex flex-1 flex-col items-center gap-1.5 text-center"
            >
              {i > 0 ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute top-3 right-1/2 h-0.5 w-full -translate-y-1/2",
                    compact && "top-2",
                    i <= done ? "bg-primary" : "bg-border",
                  )}
                />
              ) : null}
              <span
                className={cn(
                  "relative z-10 flex items-center justify-center rounded-full border text-[11px] font-semibold",
                  compact ? "size-4" : "size-6",
                  isDone
                    ? "border-primary bg-primary text-primary-foreground"
                    : isCurrent
                      ? "border-primary bg-background text-primary ring-3 ring-primary/25"
                      : "border-border bg-background text-muted-foreground",
                )}
              >
                {isDone ? <Check className={compact ? "size-2.5" : "size-3.5"} /> : compact ? null : i + 1}
              </span>
              <span className={cn("text-[11px] leading-tight", compact ? "sr-only" : isDone ? "text-foreground" : "text-muted-foreground")}>
                {label}
                {isDone ? <span className="sr-only"> ({t("stepDone")})</span> : null}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
