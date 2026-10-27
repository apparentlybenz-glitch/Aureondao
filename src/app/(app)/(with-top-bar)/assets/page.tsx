"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { PageHeader } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { formatCents, ZERO_CENTS } from "@/lib/money";
import { totalCents, useWallets } from "@/lib/wallets";

export default function AssetsPage() {
  const t = useTranslations("Assets");
  const w = useTranslations("Wallets");
  const c = useTranslations("Common");
  const h = useTranslations("Home");
  const { wallets, error } = useWallets();

  return (
    <div className="space-y-5">
      <PageHeader title={t("title")} />
      <section className="space-y-1">
        <p className="text-sm text-muted-foreground">{t("total")}</p>
        <p className="text-3xl font-semibold tabular-nums">
          {wallets ? formatCents(totalCents(wallets)) : c("loading")}
          <span className="ml-1.5 text-base font-normal text-muted-foreground">{w("currency")}</span>
        </p>
        <p className="text-xs font-medium text-amber-500">{h("virtualBalance")}</p>
      </section>

      <div className="grid grid-cols-3 gap-3">
        <Button asChild className="h-11">
          <Link href="/assets/deposit">{t("deposit")}</Link>
        </Button>
        <Button asChild className="h-11">
          <Link href="/assets/withdraw">{t("withdraw")}</Link>
        </Button>
        <Button asChild className="h-11">
          <Link href="/assets/transfer">{t("transfer")}</Link>
        </Button>
      </div>
      <Button asChild variant="secondary" className="h-11 w-full">
        <Link href="/assets/bills">{t("bills")}</Link>
      </Button>

      {error ? <p className="text-sm text-destructive">{c("genericError")}</p> : null}
      <ul className="grid gap-3 md:grid-cols-2">
        {(wallets ?? []).map((wallet) => (
          <li key={wallet.account} className="rounded-xl border bg-card p-4">
            <p className="font-medium">{w(wallet.account)}</p>
            <p className="mt-2 text-xl font-semibold tabular-nums">
              {formatCents(wallet.available + wallet.held)}
              <span className="ml-1 text-sm font-normal text-muted-foreground">{w("currency")}</span>
            </p>
            <dl className="mt-2 flex gap-4 text-xs text-muted-foreground">
              <div>
                <dt className="inline">{w("available")}: </dt>
                <dd className="inline tabular-nums">{formatCents(wallet.available)}</dd>
              </div>
              {wallet.held > ZERO_CENTS ? (
                <div>
                  <dt className="inline">{w("frozen")}: </dt>
                  <dd className="inline tabular-nums">{formatCents(wallet.held)}</dd>
                </div>
              ) : null}
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}
