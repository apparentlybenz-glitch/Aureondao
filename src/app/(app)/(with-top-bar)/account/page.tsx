"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronRight, Eye, EyeOff } from "lucide-react";
import { useTranslations } from "next-intl";
import { Avatar } from "@/components/account/avatar";
import { CopyButton } from "@/components/account/copy-button";
import { useRpcMessage } from "@/components/app/use-rpc-message";
import { FormError } from "@/components/auth/field";
import { KycBadge } from "@/components/kyc/kyc-badge";
import { Sparkline } from "@/components/market/sparkline";
import { Button } from "@/components/ui/button";
import { useBalanceHistory } from "@/lib/balance-history";
import { countryName } from "@/lib/countries";
import { kycState, useOwnKyc } from "@/lib/kyc";
import { maskEmail } from "@/lib/mask-email";
import { formatCents } from "@/lib/money";
import { useOwnProfile } from "@/lib/own-profile";
import { totalCents, useWallets } from "@/lib/wallets";

// Account Overview: identity strip, then the total balance with a 7 day line.
export default function AccountOverviewPage() {
  const t = useTranslations("Account");
  const c = useTranslations("Common");
  const k = useTranslations("Kyc");
  const rpcMessage = useRpcMessage();
  const { profile, error } = useOwnProfile();
  const { kyc } = useOwnKyc();

  return (
    <div className="space-y-5">
      <h1 className="sr-only">{t("overviewTitle")}</h1>
      <section className="flex flex-col gap-4 rounded-2xl border bg-card p-4 md:flex-row md:items-center md:justify-between md:p-6">
        <div className="flex min-w-0 items-center gap-3 md:gap-4">
          <Avatar className="md:size-16" />
          <div className="min-w-0 space-y-1.5">
            {profile ? (
              <p className="truncate text-lg font-semibold">{profile.nickname}</p>
            ) : error ? (
              <FormError message={rpcMessage(error)} />
            ) : (
              <p className="text-sm text-muted-foreground">{c("loading")}</p>
            )}
            <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <div className="flex items-center gap-1">
                <dt>{t("uid")}</dt>
                <dd className="flex items-center gap-0.5 font-mono text-foreground">
                  {profile?.uid ?? "--"}
                  {profile ? <CopyButton value={profile.uid} label={t("copyUid")} iconOnly /> : null}
                </dd>
              </div>
              <div className="flex min-w-0 items-center gap-1">
                <dt>{t("email")}</dt>
                <dd className="truncate text-foreground">{profile?.email ? maskEmail(profile.email) : "--"}</dd>
              </div>
            </dl>
            <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <div className="flex items-center gap-1">
                <dt>{k("title")}</dt>
                <dd>
                  <Link href="/account/verification" className="-my-1 inline-flex h-7 items-center gap-0.5">
                    {kyc ? <KycBadge state={kycState(kyc.current)} /> : <span>{t("countryEmpty")}</span>}
                    <ChevronRight className="size-3.5" />
                  </Link>
                </dd>
              </div>
              <div className="flex items-center gap-1">
                <dt>{t("country")}</dt>
                <dd className="text-foreground">{kyc?.current ? countryName(kyc.current.country) : t("countryEmpty")}</dd>
              </div>
            </dl>
          </div>
        </div>
        <Button asChild variant="secondary" className="h-10 w-full md:w-auto md:px-5">
          <Link href="/account/profile">{t("viewProfile")}</Link>
        </Button>
      </section>

      <BalanceCard />
    </div>
  );
}

function BalanceCard() {
  const t = useTranslations("Account");
  const a = useTranslations("Assets");
  const h = useTranslations("Home");
  const c = useTranslations("Common");
  const w = useTranslations("Wallets");
  const { wallets } = useWallets();
  const [hidden, setHidden] = useState(false);
  const total = wallets ? totalCents(wallets) : null;
  const series = useBalanceHistory(total);
  const first = series?.[0]?.cents;
  const last = series?.at(-1)?.cents;

  return (
    <section className="space-y-4 rounded-2xl border bg-card p-4 md:p-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-1 text-sm text-muted-foreground">
            {a("total")}
            <button
              type="button"
              onClick={() => setHidden((v) => !v)}
              aria-label={hidden ? h("showAmounts") : h("hideAmounts")}
              className="flex size-8 items-center justify-center rounded-full"
            >
              {hidden ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
          <p className="text-[clamp(1.5rem,7vw,2.25rem)] leading-tight font-semibold tabular-nums">
            {total === null ? c("loading") : hidden ? h("hidden") : formatCents(total)}
            <span className="ml-1.5 text-base font-normal text-muted-foreground">{w("currency")}</span>
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2 md:flex">
          <Button asChild className="h-10 md:px-5">
            <Link href="/assets/deposit">{a("deposit")}</Link>
          </Button>
          <Button asChild variant="secondary" className="h-10 md:px-5">
            <Link href="/assets/withdraw">{a("withdraw")}</Link>
          </Button>
          <Button asChild variant="secondary" className="h-10 md:px-5">
            <Link href="/assets/transfer">{a("transfer")}</Link>
          </Button>
        </div>
      </div>

      <figure className="space-y-1.5">
        <div role="img" aria-label={t("trendAria")} className="h-20 md:h-24">
          {series && !hidden ? (
            <Sparkline
              // Cents to numbers for drawing only; exact for any total below 2^53 cents.
              values={series.map((p) => Number(p.cents))}
              xs={series.map((p) => p.t)}
              width={300}
              height={80}
              svgClassName="size-full"
              className={first !== undefined && last !== undefined && last < first ? "stroke-down" : "stroke-up"}
            />
          ) : (
            <div className="size-full rounded-lg bg-muted/50" />
          )}
        </div>
        <figcaption className="text-xs text-muted-foreground">{t("trendLabel")}</figcaption>
      </figure>
    </section>
  );
}
