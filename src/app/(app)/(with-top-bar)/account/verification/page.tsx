"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { KycBadge } from "@/components/kyc/kyc-badge";
import { KYC_STEPS, KycStepper } from "@/components/kyc/kyc-stepper";
import { Button } from "@/components/ui/button";
import { kycState, useOwnKyc } from "@/lib/kyc";

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });
// Start, Update or Resubmit; no button while a submission is pending.
const ACTION = { none: "start", approved: "update", rejected: "resubmit", pending: null } as const;

// KYC gates nothing: this card only shows the state and starts a new submission.
export default function VerificationPage() {
  const t = useTranslations("Kyc");
  const c = useTranslations("Common");
  const { kyc } = useOwnKyc();

  if (kyc === undefined) return <p className="text-sm">{c("loading")}</p>;
  if (kyc === null) return <p className="text-sm text-destructive">{c("genericError")}</p>;

  const current = kyc.current;
  const state = kycState(current);
  const action = ACTION[state];

  return (
    <section aria-labelledby="kyc-title" className="space-y-5 rounded-2xl border bg-card p-4 md:p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 id="kyc-title" className="text-lg font-semibold">
            {t("title")}
          </h1>
          <p className="text-sm text-muted-foreground">{t(`status.${state}`)}</p>
        </div>
        <KycBadge state={state} className="mt-1" />
      </div>

      <KycStepper done={state === "none" ? 0 : KYC_STEPS.length} />

      {current?.status === "rejected" && current.rejection_reason ? (
        <p className="rounded-xl bg-destructive/10 p-3 text-sm">
          <span className="font-medium text-destructive">{t("reasonLabel")}: </span>
          {current.rejection_reason}
        </p>
      ) : null}

      {current ? (
        <p className="text-xs text-muted-foreground">
          {t("submittedOn", { date: dateFormat.format(new Date(current.submitted_at)) })}
        </p>
      ) : null}

      {action ? (
        <Button asChild className="h-11 w-full md:w-auto md:px-8">
          <Link href="/account/verification/submit">{t(action)}</Link>
        </Button>
      ) : null}
    </section>
  );
}
