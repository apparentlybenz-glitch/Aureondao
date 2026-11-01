"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { AdminHeading } from "@/components/admin/admin-heading";
import { bpsToPercent } from "@/lib/options-math";
import { formatCents } from "@/lib/money";
import { ACCOUNTS } from "@/lib/wallets";
import { loadAdminActions, type ActionEntry } from "./actions";

const ACTIONS = ["adjust_balance", "suspend", "unsuspend", "withdraw_restrict", "withdraw_unrestrict", "delete_user", "set_option_period", "outcome_config", "outcome_override_set", "outcome_override_clear", "kyc_approve", "kyc_reject", "kyc_photo_view", "support_reply", "support_close", "admin_grant", "admin_revoke", "head_demote", "head_remove"] as const;
type Action = (typeof ACTIONS)[number];

const dayFormat = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });
const timeFormat = new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const formatDate = (iso: string): string => {
  const d = new Date(iso);
  return `${dayFormat.format(d)} · ${timeFormat.format(d)}`;
};

// payload is jsonb, so amounts arrive as JSON numbers. They are bounded (an
// adjustment is capped at 100000000000 cents), well inside the safe integer range.
const num = (value: unknown): number => (typeof value === "number" ? value : 0);
const str = (value: unknown): string => (typeof value === "string" ? value : "");

type Loaded = { rows: ActionEntry[]; total: number } | "failed";

export function ActionsLog() {
  const t = useTranslations("Admin");
  const w = useTranslations("Wallets");
  const c = useTranslations("Common");
  const [refresh, setRefresh] = useState(0);
  const [loaded, setLoaded] = useState<{ refresh: number; result: Loaded } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let active = true;
    loadAdminActions({ offset: 0 }).then((r) => {
      if (active) setLoaded({ refresh, result: r.ok ? { rows: r.rows, total: r.total } : "failed" });
    });
    return () => {
      active = false;
    };
  }, [refresh]);

  const result = loaded?.refresh === refresh ? loaded.result : null;
  const failed = result === "failed";
  const rows = result && !failed ? result.rows : [];
  const total = result && !failed ? result.total : 0;

  async function loadMore() {
    setLoadingMore(true);
    const r = await loadAdminActions({ offset: rows.length });
    setLoadingMore(false);
    if (!r.ok) return;
    setLoaded((prev) =>
      prev && prev.refresh === refresh && prev.result !== "failed"
        ? { refresh, result: { rows: [...prev.result.rows, ...r.rows], total: r.total } }
        : prev,
    );
  }

  function detail(row: ActionEntry): string {
    const p = row.payload;
    switch (row.action) {
      case "adjust_balance": {
        const delta = BigInt(Math.trunc(num(p.delta_cents)));
        const account = ACCOUNTS.find((a) => a === p.account);
        const values = {
          amount: formatCents(delta < BigInt(0) ? -delta : delta),
          wallet: account ? w(account) : str(p.account),
        };
        return delta < BigInt(0) ? t("auditLog.summary.debit", values) : t("auditLog.summary.credit", values);
      }
      case "kyc_approve":
        return t("auditLog.summary.kycApproved");
      case "kyc_photo_view":
        return t("auditLog.summary.kycPhotoView", { count: num(p.photos) });
      case "support_reply":
      case "support_close":
        return t("auditLog.summary.ticket", { subject: str(p.subject) });
      case "delete_user":
        return t("auditLog.summary.deleteUser", { email: str(p.email) || "-", uid: str(p.uid) });
      case "suspend":
      case "unsuspend":
      case "withdraw_restrict":
      case "withdraw_unrestrict":
      case "kyc_reject":
      case "admin_grant":
      case "admin_revoke":
      case "head_demote":
      case "head_remove":
        return t("auditLog.noNote");
      case "set_option_period":
        return t("auditLog.summary.period", {
          seconds: num(p.duration_s),
          rate: bpsToPercent(num(p.profit_rate_bps)),
          fee: bpsToPercent(num(p.fee_bps)),
          min: formatCents(BigInt(Math.trunc(num(p.min_premium_cents)))),
          state: t(p.enabled === true ? "auditLog.summary.enabled" : "auditLog.summary.disabled"),
        });
      case "outcome_config":
        return t("auditLog.summary.outcomeConfig", { mode: str(p.mode), rate: num(p.win_rate_pct) });
      case "outcome_override_set":
        return t("auditLog.summary.outcomeOverride", {
          email: str(p.email) || "-",
          mode: str(p.mode),
          rate: num(p.win_rate_pct),
        });
      case "outcome_override_clear":
        return t("auditLog.summary.outcomeClear", { email: str(p.email) || "-" });
      default:
        return JSON.stringify(p);
    }
  }

  const label = (a: string): string => (ACTIONS.some((x) => x === a) ? t(`auditLog.actions.${a as Action}`) : a);
  const admin = (e: ActionEntry): string => e.admin ?? t("auditLog.deletedUser");
  const target = (e: ActionEntry): string => e.target ?? t("auditLog.noTarget");

  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <AdminHeading title={t("sections.auditLog")} description={t("auditLog.actionsDescription", { count: total })} />
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

      {result === null ? <p className="text-sm">{c("loading")}</p> : null}
      {failed ? <p className="text-sm text-destructive">{t("loadError")}</p> : null}
      {result && !failed && rows.length === 0 ? <p className="text-sm text-muted-foreground">{t("auditLog.actionsEmpty")}</p> : null}

      {rows.length > 0 ? (
        <>
          <table className="hidden w-full text-sm md:table">
            <thead className="text-left text-xs text-muted-foreground">
              <tr className="border-b">
                <th className="py-2 pr-3 font-medium">{t("auditLog.actionColumns.date")}</th>
                <th className="py-2 pr-3 font-medium">{t("auditLog.actionColumns.admin")}</th>
                <th className="py-2 pr-3 font-medium">{t("auditLog.actionColumns.action")}</th>
                <th className="py-2 pr-3 font-medium">{t("auditLog.actionColumns.target")}</th>
                <th className="py-2 font-medium">{t("auditLog.actionColumns.detail")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className="border-b align-top">
                  <td className="py-2.5 pr-3 whitespace-nowrap text-muted-foreground">
                    <time dateTime={e.createdAt}>{formatDate(e.createdAt)}</time>
                  </td>
                  <td className="py-2.5 pr-3 break-all">{admin(e)}</td>
                  <td className="py-2.5 pr-3 font-medium">{label(e.action)}</td>
                  <td className="py-2.5 pr-3 break-all">{target(e)}</td>
                  <td className="max-w-80 py-2.5 break-words text-muted-foreground">{detail(e)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <ul className="space-y-2 md:hidden">
            {rows.map((e) => (
              <li key={e.id} className="space-y-1.5 rounded-xl border bg-card p-3">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm font-medium">{label(e.action)}</p>
                  <time dateTime={e.createdAt} className="shrink-0 text-xs text-muted-foreground">
                    {formatDate(e.createdAt)}
                  </time>
                </div>
                <p className="text-sm break-words text-muted-foreground">{detail(e)}</p>
                <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                  <div className="flex gap-1">
                    <dt>{t("auditLog.actionColumns.admin")}:</dt>
                    <dd className="break-all">{admin(e)}</dd>
                  </div>
                  <div className="flex gap-1">
                    <dt>{t("auditLog.actionColumns.target")}:</dt>
                    <dd className="break-all">{target(e)}</dd>
                  </div>
                </dl>
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
