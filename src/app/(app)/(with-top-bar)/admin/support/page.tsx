"use client";

import { useEffect, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { useTranslations } from "next-intl";
import { AdminHeading } from "@/components/admin/admin-heading";
import { FormError } from "@/components/auth/field";
import { useRpcMessage } from "@/components/app/use-rpc-message";
import { SupportStatusBadge } from "@/components/support/status-badge";
import { MessageList, ReplyBox, supportDate, useThread } from "@/components/support/thread";
import { Button } from "@/components/ui/button";
import {
  SUPPORT_STATUSES,
  type SupportStatus,
  type SupportTicket,
  TICKET_SELECT,
  TICKETS_LIMIT,
} from "@/lib/support";
import { SUPPORT_TOPICS, type SupportTopic } from "@/lib/support-rules";
import { createClient } from "@/lib/supabase/client";

type AdminTicket = SupportTicket & { profiles: { email: string | null } | null };
type StatusFilter = SupportStatus | "all";
type TopicFilter = SupportTopic | "all";

const selectClass =
  "h-11 w-full rounded-lg border border-input bg-transparent px-3 text-base outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

// Every ticket under RLS (private.is_admin()), newest update first, with the
// owner's email from profiles.
async function loadTickets(status: StatusFilter, topic: TopicFilter): Promise<AdminTicket[] | null> {
  let req = createClient()
    .from("support_tickets")
    .select(`${TICKET_SELECT}, profiles(email)`)
    .order("updated_at", { ascending: false })
    .limit(TICKETS_LIMIT);
  if (status !== "all") req = req.eq("status", status);
  if (topic !== "all") req = req.eq("topic", topic);
  const { data, error } = await req.overrideTypes<AdminTicket[], { merge: false }>();
  return error ? null : data;
}

export default function SupportTicketsPage() {
  const t = useTranslations("Admin");
  const s = useTranslations("Support");
  const c = useTranslations("Common");
  const [status, setStatus] = useState<StatusFilter>("open");
  const [topic, setTopic] = useState<TopicFilter>("all");
  const [version, setVersion] = useState(0);
  const [result, setResult] = useState<AdminTicket[] | null | undefined>(undefined);
  // Kept as picked, so a reload that filters it out (after a reply or a close)
  // does not close the thread.
  const [open, setOpen] = useState<AdminTicket | null>(null);

  useEffect(() => {
    let active = true;
    loadTickets(status, topic).then((r) => {
      if (active) setResult(r);
    });
    return () => {
      active = false;
    };
  }, [status, topic, version]);

  return (
    <>
      <AdminHeading title={t("sections.support")} description={t("support.description")} />
      {open ? (
        <AdminThread key={open.id} ticket={open} onBack={() => setOpen(null)} onChanged={() => setVersion((v) => v + 1)} />
      ) : (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="support-status" className="block text-sm font-medium">
                {t("support.status")}
              </label>
              <select
                id="support-status"
                value={status}
                onChange={(e) => {
                  setResult(undefined);
                  setStatus(e.target.value as StatusFilter);
                }}
                className={selectClass}
              >
                <option value="all">{t("support.all")}</option>
                {SUPPORT_STATUSES.map((v) => (
                  <option key={v} value={v}>
                    {s(`status.${v}`)}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="support-topic" className="block text-sm font-medium">
                {t("support.topic")}
              </label>
              <select
                id="support-topic"
                value={topic}
                onChange={(e) => {
                  setResult(undefined);
                  setTopic(e.target.value as TopicFilter);
                }}
                className={selectClass}
              >
                <option value="all">{t("support.all")}</option>
                {SUPPORT_TOPICS.map((v) => (
                  <option key={v} value={v}>
                    {s(`topics.${v}`)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {result === undefined ? <p className="text-sm">{c("loading")}</p> : null}
          {result === null ? <p className="text-sm text-destructive">{t("loadError")}</p> : null}
          {result?.length === 0 ? <p className="text-sm text-muted-foreground">{t("support.empty")}</p> : null}
          <ul className="space-y-2">
            {result?.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => setOpen(row)}
                  className="flex w-full items-center justify-between gap-3 rounded-xl border bg-card p-3 text-left"
                >
                  <span className="min-w-0 space-y-0.5">
                    <span className="block truncate text-sm font-medium">{row.subject}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {row.profiles?.email ?? t("support.unknownUser")} · {s(`topics.${row.topic}`)}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {s("updated", { date: supportDate.format(new Date(row.updated_at)) })}
                    </span>
                  </span>
                  <SupportStatusBadge status={row.status} />
                </button>
              </li>
            ))}
          </ul>
          {result && result.length >= TICKETS_LIMIT ? (
            <p className="mt-3 text-center text-xs text-muted-foreground">{t("support.limit", { count: TICKETS_LIMIT })}</p>
          ) : null}
        </>
      )}
    </>
  );
}

function AdminThread({ ticket, onBack, onChanged }: { ticket: AdminTicket; onBack: () => void; onChanged: () => void }) {
  const t = useTranslations("Admin");
  const s = useTranslations("Support");
  const rpcMessage = useRpcMessage();
  const { ticket: row, messages, update, applyReply } = useThread(ticket, onChanged);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const email = row.profiles?.email ?? t("support.unknownUser");

  async function close() {
    setClosing(true);
    setError(null);
    const { data, error } = await createClient()
      .rpc("admin_support_close", { p_ticket_id: row.id })
      .single<SupportTicket>();
    setClosing(false);
    if (error) return setError(rpcMessage(error));
    update(data);
  }

  return (
    <div className="space-y-4">
      <Button type="button" variant="ghost" className="-ml-2 h-9 gap-1 px-2" onClick={onBack}>
        <ChevronLeft className="size-4" />
        {t("support.backToList")}
      </Button>
      <section className="space-y-4 rounded-xl border bg-card p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold break-words">{row.subject}</p>
            <p className="truncate text-xs text-muted-foreground">
              {email} · {s(`topics.${row.topic}`)}
            </p>
          </div>
          <SupportStatusBadge status={row.status} />
        </div>
        <MessageList messages={messages} userLabel={t("support.userLabel")} />
        {row.status === "closed" ? (
          <p className="border-t pt-4 text-sm text-muted-foreground">{t("support.closedNote")}</p>
        ) : (
          <div className="space-y-3 border-t pt-4">
            <ReplyBox
              ticketId={row.id}
              onSent={applyReply}
            />
            <FormError message={error} />
            <Button type="button" variant="outline" className="h-11 w-full" disabled={closing} onClick={close}>
              {closing ? s("sending") : t("support.close")}
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
