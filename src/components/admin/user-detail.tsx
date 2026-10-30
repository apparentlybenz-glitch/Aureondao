"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { StateBadge } from "@/components/admin/state-badge";
import { Button } from "@/components/ui/button";
import { type AdminUser, fetchRecentBills, fetchWallets } from "@/lib/admin";
import { type BillRow, useBillDescription } from "@/lib/bills";
import { centsFromText, formatCents, ZERO_CENTS } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { Wallet } from "@/lib/wallets";

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

// One user: status, the four wallet balances and the 20 most recent Bills rows.
export function UserDetail({ user, onBack }: { user: AdminUser; onBack: () => void }) {
  const t = useTranslations("Admin");
  const w = useTranslations("Wallets");
  const b = useTranslations("Bills");
  const c = useTranslations("Common");
  const describe = useBillDescription();
  const [wallets, setWallets] = useState<Wallet[] | null>(null);
  const [bills, setBills] = useState<BillRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.all([fetchWallets(user.id), fetchRecentBills(user.id)]).then(([walletRows, billRows]) => {
      if (!active) return;
      setFailed(walletRows === null || billRows === null);
      setWallets(walletRows);
      setBills(billRows);
    });
    return () => {
      active = false;
    };
  }, [user.id]);

  return (
    <div className="space-y-5">
      <Button type="button" variant="ghost" className="-ml-2 h-9" onClick={onBack}>
        {t("search.back")}
      </Button>

      <section className="space-y-2 rounded-xl border bg-card p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate font-medium">{user.email ?? user.nickname}</p>
            <p className="font-mono text-xs text-muted-foreground">{t("uid", { uid: user.uid })}</p>
          </div>
          <StateBadge suspended={user.suspended_at !== null} />
        </div>
        {user.suspended_at ? (
          <p className="text-xs text-muted-foreground">
            {t("search.since", { date: dateFormat.format(new Date(user.suspended_at)) })}
          </p>
        ) : null}
        <div className="grid grid-cols-2 gap-2 pt-1">
          <Button asChild variant="secondary" className="h-10">
            <Link href="/admin/top-up">{t("search.topUp")}</Link>
          </Button>
          <Button asChild variant="secondary" className="h-10">
            <Link href="/admin/restrictions">{t("search.restrictions")}</Link>
          </Button>
        </div>
      </section>

      {failed ? <p className="text-sm text-destructive">{t("loadError")}</p> : null}

      <section className="space-y-2">
        <h2 className="text-sm font-medium">{t("search.balances")}</h2>
        {wallets === null && !failed ? <p className="text-sm">{c("loading")}</p> : null}
        <ul className="grid grid-cols-2 gap-2 text-sm">
          {(wallets ?? []).map((x) => (
            <li key={x.account} className="rounded-xl border bg-card px-3 py-2">
              <span className="block text-xs text-muted-foreground">{w(x.account)}</span>
              <span className="tabular-nums">{formatCents(x.available)}</span>
              <span className="ml-1 text-xs text-muted-foreground">{w("currency")}</span>
              {x.held > ZERO_CENTS ? (
                <span className="block text-xs text-muted-foreground">
                  {w("frozen")}: <span className="tabular-nums">{formatCents(x.held)}</span>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">{t("search.recentBills")}</h2>
        {bills?.length === 0 ? <p className="text-sm text-muted-foreground">{t("search.noBills")}</p> : null}
        <ul className="space-y-2">
          {bills?.map((row) => {
            const delta = centsFromText(row.delta_cents);
            return (
              <li key={row.id} className="rounded-xl border bg-card p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{b(`kind.${row.kind}`)}</p>
                    {describe(row) !== b(`kind.${row.kind}`) ? (
                      <p className="text-xs text-muted-foreground">{describe(row)}</p>
                    ) : null}
                  </div>
                  <p
                    className={cn(
                      "shrink-0 text-sm font-semibold tabular-nums",
                      delta > ZERO_CENTS ? "text-up" : delta < ZERO_CENTS ? "text-down" : "",
                    )}
                  >
                    {formatCents(delta, { sign: true })}
                  </p>
                </div>
                <p className="mt-1.5 flex justify-between text-xs text-muted-foreground">
                  <span>{w(row.account)}</span>
                  <time dateTime={row.created_at}>{dateFormat.format(new Date(row.created_at))}</time>
                </p>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
