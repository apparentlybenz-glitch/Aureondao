"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { PageHeader } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { centsFromText, formatCents, ZERO_CENTS } from "@/lib/money";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { ACCOUNTS, type Account } from "@/lib/wallets";

const PAGE_SIZE = 20;

type LedgerKind =
  | "transfer_in" | "transfer_out" | "deposit" | "withdrawal_hold" | "withdrawal_release"
  | "withdrawal_paid" | "admin_credit" | "admin_debit" | "order_hold" | "order_release"
  | "spot_buy" | "spot_sell" | "forex_margin" | "forex_close" | "option_premium"
  | "option_settle" | "fee";

type BillRow = {
  id: string;
  account: Account;
  kind: LedgerKind;
  counter_account: Account | null;
  delta_cents: string;
  memo: string | null;
  created_at: string;
};

const BILL_SELECT = "id::text, account, kind, counter_account, delta_cents::text, memo, created_at";
const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

export default function BillsPage() {
  const t = useTranslations("Bills");
  const w = useTranslations("Wallets");
  const c = useTranslations("Common");
  const [filter, setFilter] = useState<Account | "all">("all");
  const [rows, setRows] = useState<BillRow[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  // Keyset pagination on (created_at, id), newest first. Own rows only, so an
  // admin session also sees just its own Bills here.
  const fetchPage = useCallback(
    async (after: BillRow | null): Promise<{ page: BillRow[]; more: boolean } | null> => {
      const supabase = createClient();
      const { data: session } = await supabase.auth.getSession();
      const uid = session.session?.user.id;
      if (!uid) return null;
      let query = supabase
        .from("ledger")
        .select(BILL_SELECT)
        .eq("user_id", uid)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(PAGE_SIZE + 1);
      if (filter !== "all") query = query.eq("account", filter);
      if (after) {
        query = query.or(
          `created_at.lt."${after.created_at}",and(created_at.eq."${after.created_at}",id.lt.${after.id})`,
        );
      }
      const { data, error } = await query.overrideTypes<BillRow[], { merge: false }>();
      if (error) return null;
      return { page: data.slice(0, PAGE_SIZE), more: data.length > PAGE_SIZE };
    },
    [filter],
  );

  useEffect(() => {
    let active = true;
    fetchPage(null).then((result) => {
      if (!active) return;
      if (!result) return setError(true);
      setRows(result.page);
      setHasMore(result.more);
    });
    return () => {
      active = false;
    };
  }, [fetchPage]);

  async function loadMore() {
    if (!rows || rows.length === 0) return;
    setLoading(true);
    const result = await fetchPage(rows[rows.length - 1]);
    if (!result) setError(true);
    else {
      setRows([...rows, ...result.page]);
      setHasMore(result.more);
    }
    setLoading(false);
  }

  function describe(row: BillRow): string {
    if (row.memo) return row.memo;
    if (row.counter_account && row.kind === "transfer_out") {
      return t("transfer", { from: w(row.account), to: w(row.counter_account) });
    }
    if (row.counter_account && row.kind === "transfer_in") {
      return t("transfer", { from: w(row.counter_account), to: w(row.account) });
    }
    return t(`kind.${row.kind}`);
  }

  return (
    <div className="space-y-4">
      <PageHeader title={t("title")} back="/assets" />

      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
        {(["all", ...ACCOUNTS] as const).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              setRows(null);
              setFilter(key);
            }}
            className={cn(
              "h-8 shrink-0 rounded-full border px-3 text-sm",
              filter === key ? "border-foreground bg-foreground text-background" : "text-muted-foreground",
            )}
          >
            {key === "all" ? c("all") : w(key)}
          </button>
        ))}
      </div>

      {error ? <p className="text-sm text-destructive">{c("genericError")}</p> : null}
      {rows === null && !error ? <p className="text-sm">{c("loading")}</p> : null}
      {rows?.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">{t("empty")}</p> : null}

      <ul className="space-y-3">
        {rows?.map((row) => {
          const delta = centsFromText(row.delta_cents);
          return (
            <li key={row.id} className="rounded-xl border bg-card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{t(`kind.${row.kind}`)}</p>
                  <p className="text-sm text-muted-foreground">{describe(row)}</p>
                </div>
                <p
                  className={cn(
                    "shrink-0 font-semibold tabular-nums",
                    delta > ZERO_CENTS ? "text-up" : delta < ZERO_CENTS ? "text-down" : "",
                  )}
                >
                  {formatCents(delta, { sign: true })}
                  <span className="ml-1 text-xs font-normal text-muted-foreground">{w("currency")}</span>
                </p>
              </div>
              <p className="mt-2 flex justify-between text-xs text-muted-foreground">
                <span>{w(row.account)}</span>
                <time dateTime={row.created_at}>{dateFormat.format(new Date(row.created_at))}</time>
              </p>
            </li>
          );
        })}
      </ul>

      {rows && rows.length > 0 ? (
        hasMore ? (
          <Button variant="secondary" className="h-11 w-full" onClick={loadMore} disabled={loading}>
            {loading ? c("loading") : c("loadMore")}
          </Button>
        ) : (
          <p className="text-center text-xs text-muted-foreground">{c("noMore")}</p>
        )
      ) : null}
    </div>
  );
}
