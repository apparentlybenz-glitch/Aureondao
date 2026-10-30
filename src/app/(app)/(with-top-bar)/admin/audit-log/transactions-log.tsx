"use client";

import { useEffect, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { AdminHeading } from "@/components/admin/admin-heading";
import { GROUPS, groupOf, type LedgerGroup } from "@/lib/ledger-groups";
import { formatCents } from "@/lib/money";
import { cn } from "@/lib/utils";
import { loadLedger, type LedgerEntry } from "./actions";

const DEBOUNCE_MS = 300;

// Two brand hues only (green, crimson), so the rest are told apart by fill.
const BADGE: Record<LedgerGroup, string> = {
  adjustment: "bg-primary/15 text-primary",
  transfer: "bg-foreground/10 text-foreground",
  spot: "bg-secondary text-secondary-foreground",
  options: "border border-primary/40 text-primary/80",
  fee: "border border-border text-muted-foreground",
};

const dayFormat = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });
const timeFormat = new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const formatDate = (iso: string): string => {
  const d = new Date(iso);
  return `${dayFormat.format(d)} · ${timeFormat.format(d)}`;
};

const formatAmount = (deltaCents: string): string => {
  const cents = BigInt(deltaCents);
  return `${cents < BigInt(0) ? "-" : ""}$${formatCents(cents < BigInt(0) ? -cents : cents)}`;
};

type Loaded = { key: string; rows: LedgerEntry[]; total: number } | { key: string; failed: true };

export function TransactionsLog() {
  const t = useTranslations("Admin");
  const w = useTranslations("Wallets");
  const c = useTranslations("Common");
  const [input, setInput] = useState("");
  const [term, setTerm] = useState("");
  const [group, setGroup] = useState<LedgerGroup | "all">("all");
  const [refresh, setRefresh] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const key = `${term}|${group}|${refresh}`;

  useEffect(() => {
    const timer = setTimeout(() => setTerm(input.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input]);

  useEffect(() => {
    let active = true;
    loadLedger({ q: term, group, offset: 0 }).then((r) => {
      if (active) setLoaded(r.ok ? { key, rows: r.rows, total: r.total } : { key, failed: true });
    });
    return () => {
      active = false;
    };
  }, [key, term, group]);

  const current = loaded?.key === key ? loaded : null;
  const rows = current && !("failed" in current) ? current.rows : [];
  const total = current && !("failed" in current) ? current.total : 0;
  const failed = current !== null && "failed" in current;

  async function loadMore() {
    setLoadingMore(true);
    const r = await loadLedger({ q: term, group, offset: rows.length });
    setLoadingMore(false);
    if (!r.ok) return;
    setLoaded((prev) => (prev && prev.key === key && !("failed" in prev) ? { ...prev, rows: [...prev.rows, ...r.rows], total: r.total } : prev));
  }

  const wallet = (e: LedgerEntry): string => {
    if (e.counterAccount && e.kind === "transfer_out") return t("auditLog.route", { from: w(e.account), to: w(e.counterAccount) });
    if (e.counterAccount && e.kind === "transfer_in") return t("auditLog.route", { from: w(e.counterAccount), to: w(e.account) });
    return w(e.account);
  };
  const badge = (e: LedgerEntry) => {
    const g = groupOf(e.kind);
    return g ? (
      <span className={cn("inline-block shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold", BADGE[g])}>
        {t(`auditLog.types.${g}`)}
      </span>
    ) : null;
  };
  const email = (e: LedgerEntry): string => e.email ?? t("auditLog.deletedUser");
  const note = (e: LedgerEntry): string => e.note ?? t("auditLog.noNote");

  const pillClass = (active: boolean) =>
    cn(
      "h-8 shrink-0 rounded-full px-3 text-xs font-medium transition-colors",
      active ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:text-foreground",
    );

  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <AdminHeading title={t("sections.auditLog")} description={t("auditLog.description", { count: total })} />
        </div>
        <button
          type="button"
          onClick={() => setRefresh((n) => n + 1)}
          aria-label={t("auditLog.refresh")}
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <RefreshCw className="size-4" aria-hidden />
        </button>
      </div>

      <div className="mb-4 flex flex-col gap-2 md:flex-row md:items-center">
        <div className="relative md:flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            type="search"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            aria-label={t("auditLog.searchLabel")}
            placeholder={t("auditLog.searchPlaceholder")}
            className="h-11 w-full rounded-lg border border-input bg-input pr-3 pl-9 text-base outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        </div>
        <div role="group" aria-label={t("auditLog.typeLabel")} className="-mx-4 flex gap-1 overflow-x-auto px-4 md:mx-0 md:rounded-lg md:border md:bg-card md:p-1">
          <button type="button" aria-pressed={group === "all"} onClick={() => setGroup("all")} className={pillClass(group === "all")}>
            {t("auditLog.all")}
          </button>
          {GROUPS.map((g) => (
            <button key={g} type="button" aria-pressed={group === g} onClick={() => setGroup(g)} className={pillClass(group === g)}>
              {t(`auditLog.types.${g}`)}
            </button>
          ))}
        </div>
      </div>

      {current === null ? <p className="text-sm">{c("loading")}</p> : null}
      {failed ? <p className="text-sm text-destructive">{t("loadError")}</p> : null}
      {current && !failed && rows.length === 0 ? <p className="text-sm text-muted-foreground">{t("auditLog.empty")}</p> : null}

      {rows.length > 0 ? (
        <>
          <table className="hidden w-full text-sm md:table">
            <thead className="text-left text-xs text-muted-foreground">
              <tr className="border-b">
                <th className="py-2 pr-3 font-medium">{t("auditLog.columns.date")}</th>
                <th className="py-2 pr-3 font-medium">{t("auditLog.columns.user")}</th>
                <th className="py-2 pr-3 font-medium">{t("auditLog.columns.type")}</th>
                <th className="py-2 pr-3 font-medium">{t("auditLog.columns.wallets")}</th>
                <th className="py-2 pr-3 text-right font-medium">{t("auditLog.columns.amount")}</th>
                <th className="py-2 font-medium">{t("auditLog.columns.note")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className="border-b">
                  <td className="py-2.5 pr-3 whitespace-nowrap text-muted-foreground">
                    <time dateTime={e.createdAt}>{formatDate(e.createdAt)}</time>
                  </td>
                  <td className="py-2.5 pr-3 break-all">{email(e)}</td>
                  <td className="py-2.5 pr-3">{badge(e)}</td>
                  <td className="py-2.5 pr-3 whitespace-nowrap text-muted-foreground">{wallet(e)}</td>
                  <td className="py-2.5 pr-3 text-right font-medium whitespace-nowrap tabular-nums">{formatAmount(e.deltaCents)}</td>
                  <td className="max-w-64 py-2.5 break-words text-muted-foreground">{note(e)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <ul className="space-y-2 md:hidden">
            {rows.map((e) => (
              <li key={e.id} className="space-y-1.5 rounded-xl border bg-card p-3">
                <div className="flex items-start justify-between gap-3">
                  {badge(e)}
                  <p className="text-sm font-medium tabular-nums">{formatAmount(e.deltaCents)}</p>
                </div>
                <p className="text-sm break-all">{email(e)}</p>
                {e.note ? <p className="text-sm break-words text-muted-foreground">{e.note}</p> : null}
                <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span>{wallet(e)}</span>
                  <time dateTime={e.createdAt}>{formatDate(e.createdAt)}</time>
                </div>
              </li>
            ))}
          </ul>

          {rows.length < total ? (
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
              className="mx-auto mt-4 block h-10 rounded-lg border px-4 text-sm font-medium hover:bg-secondary disabled:opacity-60"
            >
              {loadingMore ? c("loading") : t("auditLog.loadMore")}
            </button>
          ) : null}
        </>
      ) : null}
    </>
  );
}
