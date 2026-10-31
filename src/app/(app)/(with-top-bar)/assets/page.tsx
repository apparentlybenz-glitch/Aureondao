"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { InfoCard, InfoRow } from "@/components/account/info-card";
import { PageHeader } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { formatCents, ZERO_CENTS } from "@/lib/money";
import { totalCents, useWallets } from "@/lib/wallets";

// Assets in the account card and row layout: the total with its actions, then one
// row per wallet (total, with available and frozen under it).
export default function AssetsPage() {
  const t = useTranslations("Assets");
  const w = useTranslations("Wallets");
  const c = useTranslations("Common");
  const { wallets, error } = useWallets();

  return (
    <div className="space-y-5">
      <PageHeader title={t("title")} />

      <section className="space-y-4 rounded-2xl border bg-card p-4 md:p-6">
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">{t("total")}</p>
          <p className="text-[clamp(1.5rem,7vw,2.25rem)] leading-tight font-semibold tabular-nums">
            {wallets ? formatCents(totalCents(wallets)) : c("loading")}
            <span className="ml-1.5 text-base font-normal text-muted-foreground">{w("currency")}</span>
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2 md:flex">
          <Button asChild className="h-10 md:px-5">
            <Link href="/assets/deposit">{t("deposit")}</Link>
          </Button>
          <Button asChild variant="secondary" className="h-10 md:px-5">
            <Link href="/assets/withdraw">{t("withdraw")}</Link>
          </Button>
          <Button asChild variant="secondary" className="h-10 md:px-5">
            <Link href="/assets/transfer">{t("transfer")}</Link>
          </Button>
          <Button asChild variant="secondary" className="col-span-3 h-10 md:col-span-1 md:ml-auto md:px-5">
            <Link href="/assets/bills">{t("bills")}</Link>
          </Button>
        </div>
      </section>

      {error ? <p className="text-sm text-destructive">{c("genericError")}</p> : null}
      <InfoCard title={t("wallets")}>
        {wallets === null ? (
          <p className="py-3 text-sm text-muted-foreground">{c("loading")}</p>
        ) : (
          wallets.map((wallet) => (
            <InfoRow key={wallet.account} label={w(wallet.account)}>
              <span className="text-base font-semibold tabular-nums">{formatCents(wallet.available + wallet.held)}</span>
              <span className="ml-1 text-xs text-muted-foreground">{w("currency")}</span>
              <span className="mt-0.5 flex gap-3 text-xs text-muted-foreground tabular-nums">
                <span>
                  {w("available")}: {formatCents(wallet.available)}
                </span>
                {wallet.held > ZERO_CENTS ? (
                  <span>
                    {w("frozen")}: {formatCents(wallet.held)}
                  </span>
                ) : null}
              </span>
            </InfoRow>
          ))
        )}
      </InfoCard>
    </div>
  );
}
