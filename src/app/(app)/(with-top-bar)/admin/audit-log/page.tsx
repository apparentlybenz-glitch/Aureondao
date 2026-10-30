"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { ActionsLog } from "./actions-log";
import { TransactionsLog } from "./transactions-log";

const TABS = ["transactions", "actions"] as const;

export default function AuditLogPage() {
  const t = useTranslations("Admin");
  const [tab, setTab] = useState<(typeof TABS)[number]>("transactions");

  return (
    <>
      <div role="group" aria-label={t("auditLog.tabs.label")} className="mb-4 inline-flex rounded-lg border bg-card p-1">
        {TABS.map((id) => (
          <button
            key={id}
            type="button"
            aria-pressed={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              "h-8 rounded-md px-3 text-sm font-medium transition-colors",
              tab === id ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`auditLog.tabs.${id}`)}
          </button>
        ))}
      </div>
      {tab === "transactions" ? <TransactionsLog /> : <ActionsLog />}
    </>
  );
}
