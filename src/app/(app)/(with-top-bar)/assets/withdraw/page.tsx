"use client";

import { useTranslations } from "next-intl";
import { PageHeader } from "@/components/app/page-header";
import { CoinNetworkFields } from "@/components/assets/coin-network-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCents } from "@/lib/money";
import { cn } from "@/lib/utils";
import { useWallets } from "@/lib/wallets";
import { useWithdrawRestricted } from "@/lib/withdraw-restriction";

// Display only. Every field and the button are disabled: virtual balances cannot
// be withdrawn, so there is no form, no submit and no address is stored.
// An admin can restrict withdrawals per account (profiles.withdraw_restricted_at): the page
// stays open, and that account's button turns grey and reads "Restricted, contact support".
export default function WithdrawPage() {
  const t = useTranslations("Withdraw");
  const w = useTranslations("Wallets");
  const { wallets } = useWallets();
  const restricted = useWithdrawRestricted();
  const capital = wallets?.find((x) => x.account === "capital");

  return (
    <div className="mx-auto w-full max-w-[480px] space-y-5">
      <PageHeader title={t("title")} back="/assets" />
      <p className="text-sm text-muted-foreground">{t("subtitle")}</p>

      <section className="space-y-5 rounded-2xl border bg-card p-4">
        <CoinNetworkFields />

        <div className="space-y-1.5">
          <Label htmlFor="withdraw-address" className="text-sm font-normal text-muted-foreground">{t("address")}</Label>
          <Input
            id="withdraw-address"
            disabled
            autoComplete="off"
            placeholder={t("addressPlaceholder")}
            className="h-12 font-mono text-base"
          />
        </div>

        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <Label htmlFor="withdraw-amount" className="text-sm font-normal text-muted-foreground">{t("amount")}</Label>
            <span className="text-xs text-muted-foreground tabular-nums">
              {t("available", { amount: capital ? formatCents(capital.available) : "--" })}
            </span>
          </div>
          <div className="relative">
            <Input
              id="withdraw-amount"
              disabled
              inputMode="decimal"
              autoComplete="off"
              placeholder={t("amountPlaceholder")}
              className="h-12 pr-28 text-base"
            />
            <div className="pointer-events-none absolute inset-y-0 right-3 flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">{w("currency")}</span>
              <button type="button" disabled className="pointer-events-auto text-xs font-semibold text-primary disabled:opacity-50">
                {t("max")}
              </button>
            </div>
          </div>
        </div>

        <dl className="divide-y rounded-xl border text-sm">
          <div className="flex items-center justify-between px-3 py-2.5">
            <dt className="text-muted-foreground">{t("summaryAmount")}</dt>
            <dd className="tabular-nums">{t("summaryEmpty")}</dd>
          </div>
          <div className="flex items-center justify-between px-3 py-2.5">
            <dt className="text-muted-foreground">{t("summaryRemoved")}</dt>
            <dd className="tabular-nums">{t("summaryEmpty")}</dd>
          </div>
        </dl>

        <div className="space-y-3">
          <Button
            type="button"
            disabled
            variant={restricted ? "secondary" : "default"}
            className={cn("h-12 w-full", restricted && "text-muted-foreground")}
          >
            {restricted ? t("restrictedButton") : t("submit")}
          </Button>
        </div>
      </section>
    </div>
  );
}
