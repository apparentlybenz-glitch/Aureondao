"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { AdminHeading } from "@/components/admin/admin-heading";
import { bpsToPercent } from "@/lib/options-math";
import { formatCents } from "@/lib/money";
import { createClient } from "@/lib/supabase/client";
import { ACCOUNTS } from "@/lib/wallets";

const LIMIT = 100;
const ACTIONS = ["adjust_balance", "suspend", "unsuspend", "set_option_period", "kyc_approve", "kyc_reject", "kyc_photo_view"] as const;
type Action = (typeof ACTIONS)[number];

type AuditRow = {
  id: string;
  admin_id: string | null;
  action: string;
  target_user_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
};

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

// payload is jsonb, so amounts arrive as JSON numbers. They are bounded (an
// adjustment is capped at 100000000000 cents), well inside the safe integer range.
const num = (value: unknown): number => (typeof value === "number" ? value : 0);
const str = (value: unknown): string => (typeof value === "string" ? value : "");

async function loadAudit(action: Action | "all") {
  const supabase = createClient();
  let req = supabase
    .from("admin_audit_log")
    .select("id, admin_id, action, target_user_id, payload, created_at")
    .order("created_at", { ascending: false })
    .limit(LIMIT);
  if (action !== "all") req = req.eq("action", action);
  const { data, error } = await req.overrideTypes<AuditRow[], { merge: false }>();
  if (error) return null;

  // Emails come from profiles, which an admin can read.
  const ids = [...new Set(data.flatMap((r) => [r.admin_id, r.target_user_id]).filter((id): id is string => id !== null))];
  const emails = new Map<string, string>();
  if (ids.length > 0) {
    const { data: people } = await supabase
      .from("profiles")
      .select("id, email, nickname")
      .in("id", ids)
      .overrideTypes<{ id: string; email: string | null; nickname: string }[], { merge: false }>();
    for (const p of people ?? []) emails.set(p.id, p.email ?? p.nickname);
  }
  return { rows: data, emails };
}

export default function AuditLogPage() {
  const t = useTranslations("Admin");
  const w = useTranslations("Wallets");
  const c = useTranslations("Common");
  const [action, setAction] = useState<Action | "all">("all");
  const [result, setResult] = useState<{ rows: AuditRow[]; emails: Map<string, string> } | null | undefined>(undefined);

  useEffect(() => {
    let active = true;
    loadAudit(action).then((r) => {
      if (active) setResult(r);
    });
    return () => {
      active = false;
    };
  }, [action]);

  function summary(row: AuditRow): string {
    const p = row.payload;
    switch (row.action) {
      case "adjust_balance": {
        const delta = BigInt(Math.trunc(num(p.delta_cents)));
        const account = ACCOUNTS.find((a) => a === p.account);
        const values = {
          amount: formatCents(delta < BigInt(0) ? -delta : delta),
          wallet: account ? w(account) : str(p.account),
          reason: str(p.reason),
        };
        return delta < BigInt(0) ? t("auditLog.summary.debit", values) : t("auditLog.summary.credit", values);
      }
      case "kyc_approve":
        return t("auditLog.summary.kycApproved");
      case "kyc_photo_view":
        return t("auditLog.summary.kycPhotoView", { count: num(p.photos) });
      case "suspend":
      case "unsuspend":
      case "kyc_reject":
        return str(p.reason) ? t("auditLog.summary.reason", { reason: str(p.reason) }) : t("auditLog.summary.noReason");
      case "set_option_period":
        return t("auditLog.summary.period", {
          seconds: num(p.duration_s),
          rate: bpsToPercent(num(p.profit_rate_bps)),
          fee: bpsToPercent(num(p.fee_bps)),
          min: formatCents(BigInt(Math.trunc(num(p.min_premium_cents)))),
          state: t(p.enabled === true ? "auditLog.summary.enabled" : "auditLog.summary.disabled"),
        });
      default:
        return JSON.stringify(p);
    }
  }

  const who = (id: string | null): string => (id ? (result?.emails.get(id) ?? id) : t("auditLog.deletedUser"));
  const label = (a: string): string => (ACTIONS.some((x) => x === a) ? t(`auditLog.actions.${a as Action}`) : a);

  return (
    <>
      <AdminHeading title={t("sections.auditLog")} description={t("auditLog.description")} />
      <div className="mb-4 space-y-1.5">
        <label htmlFor="audit-action" className="block text-sm font-medium">
          {t("auditLog.filter")}
        </label>
        <select
          id="audit-action"
          value={action}
          onChange={(e) => {
            setResult(undefined);
            setAction(e.target.value as Action | "all");
          }}
          className="h-11 w-full rounded-lg border border-input bg-transparent px-3 text-base outline-none focus-visible:ring-3 focus-visible:ring-ring/50 md:max-w-xs"
        >
          <option value="all">{t("auditLog.all")}</option>
          {ACTIONS.map((a) => (
            <option key={a} value={a}>
              {t(`auditLog.actions.${a}`)}
            </option>
          ))}
        </select>
      </div>

      {result === undefined ? <p className="text-sm">{c("loading")}</p> : null}
      {result === null ? <p className="text-sm text-destructive">{t("loadError")}</p> : null}
      {result?.rows.length === 0 ? <p className="text-sm text-muted-foreground">{t("auditLog.empty")}</p> : null}
      <ul className="space-y-2">
        {result?.rows.map((row) => (
          <li key={row.id} className="space-y-1.5 rounded-xl border bg-card p-3">
            <div className="flex items-start justify-between gap-3">
              <p className="text-sm font-medium">{label(row.action)}</p>
              <time dateTime={row.created_at} className="shrink-0 text-xs text-muted-foreground">
                {dateFormat.format(new Date(row.created_at))}
              </time>
            </div>
            <p className="text-sm text-muted-foreground">{summary(row)}</p>
            <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
              <div className="flex gap-1">
                <dt>{t("auditLog.admin")}:</dt>
                <dd className="break-all">{who(row.admin_id)}</dd>
              </div>
              {row.target_user_id || row.action !== "set_option_period" ? (
                <div className="flex gap-1">
                  <dt>{t("auditLog.target")}:</dt>
                  <dd className="break-all">{who(row.target_user_id)}</dd>
                </div>
              ) : null}
            </dl>
          </li>
        ))}
      </ul>
      {result && result.rows.length >= LIMIT ? (
        <p className="mt-3 text-center text-xs text-muted-foreground">{t("auditLog.limit", { count: LIMIT })}</p>
      ) : null}
    </>
  );
}
