"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { FormError } from "@/components/auth/field";
import { AdminHeading } from "@/components/admin/admin-heading";
import { useRpcMessage } from "@/components/app/use-rpc-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { centsToInput, parseAmount, ZERO_CENTS } from "@/lib/money";
import { type OptionPeriod, useOptionPeriods } from "@/lib/options";
import { bpsToPercentText, minPremiumFloorCents, percentToBps } from "@/lib/options-math";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

// The limits admin_set_option_period enforces: profit rate 0 to 1000 %, fee 0 to 10 %.
const MAX_PROFIT_BPS = 100000;
const MAX_FEE_BPS = 1000;

export default function OptionPeriodsPage() {
  const t = useTranslations("Admin");
  const c = useTranslations("Common");
  // Live: a saved row arrives back over Realtime.
  const periods = useOptionPeriods();
  return (
    <>
      <AdminHeading title={t("sections.optionPeriods")} description={t("optionPeriods.description")} />
      {periods === null ? <p className="text-sm">{c("loading")}</p> : null}
      <ul className="space-y-3">
        {periods?.map((p) => (
          <li key={p.durationS}>
            <PeriodRow period={p} />
          </li>
        ))}
      </ul>
    </>
  );
}

function PeriodRow({ period }: { period: OptionPeriod }) {
  const t = useTranslations("Admin");
  const rpcMessage = useRpcMessage();
  const [profit, setProfit] = useState(bpsToPercentText(period.profitRateBps));
  const [fee, setFee] = useState(bpsToPercentText(period.feeBps));
  const [minPremium, setMinPremium] = useState(centsToInput(period.minPremium));
  const [enabled, setEnabled] = useState(period.enabled);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const profitBps = percentToBps(profit);
  const feeBps = percentToBps(fee);
  const minCents = parseAmount(minPremium);

  // Field errors mirror what the RPC refuses, so each one is named here.
  const profitError = profitBps === null || profitBps > MAX_PROFIT_BPS ? t("optionPeriods.errors.profitRate") : null;
  const feeError = feeBps === null || feeBps > MAX_FEE_BPS ? t("optionPeriods.errors.fee") : null;
  const minError = minCents === null || minCents <= ZERO_CENTS ? t("optionPeriods.errors.minPremium") : null;
  const enabledError = enabled && profitBps === 0 ? t("optionPeriods.errors.enabledNeedsRate") : null;
  // An enabled period needs a minimum premium above the floor (option_periods_min_premium_floor).
  const floorCents = profitBps !== null && feeBps !== null ? minPremiumFloorCents(profitBps, feeBps) : null;
  const floorError =
    enabled && profitBps !== null && profitBps > 0 && feeBps !== null && !minError
      ? floorCents === null
        ? t("optionPeriods.errors.rateBelowFee")
        : minCents !== null && minCents < floorCents
          ? t("optionPeriods.errors.minPremiumFloor", { min: centsToInput(floorCents) })
          : null
      : null;
  const valid = !profitError && !feeError && !minError && !enabledError && !floorError;

  const dirty =
    profitBps !== period.profitRateBps ||
    feeBps !== period.feeBps ||
    minCents !== period.minPremium ||
    enabled !== period.enabled;

  // Any edit clears the last result.
  function touch() {
    setSaved(false);
    setError(null);
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!valid || pending || profitBps === null || feeBps === null || minCents === null) return;
    setPending(true);
    setError(null);
    const { error } = await createClient().rpc("admin_set_option_period", {
      p_duration_s: period.durationS,
      p_profit_rate_bps: profitBps,
      p_fee_bps: feeBps,
      p_min_premium_cents: minCents.toString(),
      p_enabled: enabled,
    });
    setPending(false);
    if (error) return setError(rpcMessage(error));
    setSaved(true);
  }

  const id = `period-${period.durationS}`;
  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-medium">{t("optionPeriods.period", { seconds: period.durationS })}</h2>
        <label htmlFor={`${id}-enabled`} className="flex items-center gap-2 text-sm">
          {t("optionPeriods.enabled")}
          <button
            id={`${id}-enabled`}
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={() => {
              setEnabled(!enabled);
              touch();
            }}
            className={cn(
              "relative h-6 w-11 shrink-0 rounded-full transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              enabled ? "bg-primary" : "bg-muted",
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 left-0.5 size-5 rounded-full bg-white transition-transform motion-reduce:transition-none",
                enabled ? "translate-x-5" : "",
              )}
            />
          </button>
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-profit`}>{t("optionPeriods.profitRate")}</Label>
          <Input
            id={`${id}-profit`}
            inputMode="decimal"
            autoComplete="off"
            className="h-11 text-base"
            value={profit}
            aria-invalid={profitError !== null}
            onChange={(e) => {
              setProfit(e.target.value);
              touch();
            }}
          />
          <FormError message={profitError} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-fee`}>{t("optionPeriods.fee")}</Label>
          <Input
            id={`${id}-fee`}
            inputMode="decimal"
            autoComplete="off"
            className="h-11 text-base"
            value={fee}
            aria-invalid={feeError !== null}
            onChange={(e) => {
              setFee(e.target.value);
              touch();
            }}
          />
          <FormError message={feeError} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-min`}>{t("optionPeriods.minPremium")}</Label>
          <Input
            id={`${id}-min`}
            inputMode="decimal"
            autoComplete="off"
            className="h-11 text-base"
            value={minPremium}
            aria-invalid={minError !== null}
            onChange={(e) => {
              setMinPremium(e.target.value);
              touch();
            }}
          />
          <FormError message={minError} />
        </div>
      </div>
      <FormError message={enabledError} />
      <FormError message={floorError} />
      <FormError message={error} />
      {saved ? (
        <p role="status" className="text-sm text-up">
          {t("optionPeriods.saved")}
        </p>
      ) : null}
      <Button type="submit" className="h-11 w-full" disabled={!valid || !dirty || pending}>
        {pending ? t("optionPeriods.saving") : t("optionPeriods.save")}
      </Button>
    </form>
  );
}
