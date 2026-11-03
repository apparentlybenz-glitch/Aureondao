"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, LifeBuoy } from "lucide-react";
import { useTranslations } from "next-intl";
import { FormError } from "@/components/auth/field";
import { useRpcMessage } from "@/components/app/use-rpc-message";
import { SupportStatusBadge } from "@/components/support/status-badge";
import { Counter, MessageList, ReplyBox, supportDate, textareaClass, useThread } from "@/components/support/thread";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useAttemptKey } from "@/lib/attempt-key";
import { notify } from "@/lib/notify";
import { onVisible } from "@/lib/on-visible";
import { serverAnswered } from "@/lib/rpc-error";
import { fetchOwnTickets, type SupportTicket } from "@/lib/support";
import { BODY_MAX, bodyOk } from "@/lib/support-rules";
import { createClient } from "@/lib/supabase/client";
import { useHydrated } from "@/lib/use-hydrated";
import { LoadingRows } from "@/components/ui/skeleton";

// The user's Support page: header, the new ticket form and "Your tickets", or
// one ticket's thread. Reloads the list when the tab becomes visible.
export function SupportScreen() {
  const t = useTranslations("Support");
  const c = useTranslations("Common");
  const [tickets, setTickets] = useState<SupportTicket[] | null | undefined>(undefined);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const run = () =>
      void fetchOwnTickets().then((r) => {
        if (active) setTickets(r);
      });
    run();
    const stop = onVisible(run);
    return () => {
      active = false;
      stop();
    };
  }, []);

  const open = tickets?.find((x) => x.id === openId) ?? null;
  // Merges a change into its ticket and keeps the list newest update first.
  const merge = (id: string, changes: Partial<SupportTicket>) =>
    setTickets((list) =>
      (list ?? [])
        .map((x) => (x.id === id ? { ...x, ...changes } : x))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    );

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <LifeBuoy className="size-5 text-primary-text" aria-hidden />
          {t("title")}
        </h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </header>

      {open ? (
        <Thread key={open.id} ticket={open} onBack={() => setOpenId(null)} onChanged={(changes) => merge(open.id, changes)} />
      ) : (
        <>
          <NewTicketForm onCreated={(ticket) => setTickets((list) => [ticket, ...(list ?? [])])} />
          <section className="space-y-2">
            <h2 className="text-base font-semibold">{t("yourTickets")}</h2>
            {tickets === undefined ? <LoadingRows label={c("loading")} rowClassName="h-16" /> : null}
            {tickets === null ? <p className="text-sm text-destructive">{t("loadError")}</p> : null}
            {tickets?.length === 0 ? <p className="text-sm text-muted-foreground">{t("noTickets")}</p> : null}
            <ul className="space-y-2">
              {tickets?.map((ticket) => (
                <li key={ticket.id}>
                  <button
                    type="button"
                    onClick={() => setOpenId(ticket.id)}
                    className="flex w-full items-center justify-between gap-3 rounded-xl border bg-card p-3 text-left"
                  >
                    <span className="min-w-0 space-y-0.5">
                      <span className="block truncate text-sm font-medium">{ticket.subject}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {t("updated", { date: supportDate.format(new Date(ticket.updated_at)) })}
                      </span>
                    </span>
                    <SupportStatusBadge status={ticket.status} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

function NewTicketForm({ onCreated }: { onCreated: (ticket: SupportTicket) => void }) {
  const t = useTranslations("Support");
  const rpcMessage = useRpcMessage();
  const hydrated = useHydrated();
  const attempt = useAttemptKey();
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = bodyOk(body);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || sending) return;
    setSending(true);
    setError(null);
    const b = body.trim();
    const { data, error } = await createClient()
      .rpc("support_create_ticket", { p_body: b, p_client_request_id: attempt.keyFor(b) })
      .single<SupportTicket>();
    setSending(false);
    if (error) {
      if (serverAnswered(error)) attempt.settle();
      setError(rpcMessage(error));
      return;
    }
    attempt.settle();
    setBody("");
    notify({ title: t("submitted") });
    onCreated(data);
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-xl border bg-card p-4">
      <div className="space-y-1.5">
        <Label htmlFor="support-message" className="text-xs tracking-wide text-muted-foreground uppercase">
          {t("message")}
        </Label>
        <textarea
          id="support-message"
          maxLength={BODY_MAX}
          placeholder={t("messagePlaceholder")}
          className={`${textareaClass} bg-muted/40`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <Counter value={body} />
      </div>

      <FormError message={error} />
      <Button type="submit" className="h-11 w-full" disabled={!hydrated || !valid || sending}>
        {sending ? t("sending") : t("submit")}
      </Button>
    </form>
  );
}

function Thread({
  ticket: initial,
  onBack,
  onChanged,
}: {
  ticket: SupportTicket;
  onBack: () => void;
  onChanged: (changes: Partial<SupportTicket>) => void;
}) {
  const t = useTranslations("Support");
  const { ticket, messages, applyReply } = useThread(initial, onChanged);
  return (
    <div className="space-y-4">
      <Button type="button" variant="ghost" className="-ml-2 h-9 gap-1 px-2" onClick={onBack}>
        <ChevronLeft className="size-4" />
        {t("backToTickets")}
      </Button>
      <section className="space-y-4 rounded-xl border bg-card p-4">
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 truncate text-xs text-muted-foreground">
            {t("updated", { date: supportDate.format(new Date(ticket.updated_at)) })}
          </p>
          <SupportStatusBadge status={ticket.status} />
        </div>
        <MessageList messages={messages} userLabel={t("youLabel")} />
        {ticket.status === "closed" ? (
          <p className="border-t pt-4 text-sm text-muted-foreground">{t("closedNote")}</p>
        ) : (
          <div className="border-t pt-4">
            <ReplyBox
              ticketId={ticket.id}
              onSent={applyReply}
            />
          </div>
        )}
      </section>
    </div>
  );
}
