"use client";

import { useEffect, useState } from "react";
import { Check, ChevronDown, ChevronLeft, LifeBuoy } from "lucide-react";
import { Select } from "radix-ui";
import { useTranslations } from "next-intl";
import { FormError } from "@/components/auth/field";
import { useRpcMessage } from "@/components/app/use-rpc-message";
import { SupportStatusBadge } from "@/components/support/status-badge";
import { Counter, MessageList, ReplyBox, supportDate, textareaClass, useThread } from "@/components/support/thread";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAttemptKey } from "@/lib/attempt-key";
import { notify } from "@/lib/notify";
import { onVisible } from "@/lib/on-visible";
import { serverAnswered } from "@/lib/rpc-error";
import { fetchOwnTickets, type SupportTicket } from "@/lib/support";
import { BODY_MAX, SUBJECT_MAX, SUPPORT_TOPICS, ticketOk } from "@/lib/support-rules";
import { createClient } from "@/lib/supabase/client";
import { useHydrated } from "@/lib/use-hydrated";

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
          <LifeBuoy className="size-5 text-primary" aria-hidden />
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
            {tickets === undefined ? <p className="text-sm">{c("loading")}</p> : null}
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
                        {t(`topics.${ticket.topic}`)} · {t("updated", { date: supportDate.format(new Date(ticket.updated_at)) })}
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
  const [topic, setTopic] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = ticketOk(topic, subject, body);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || sending) return;
    setSending(true);
    setError(null);
    const s = subject.trim();
    const b = body.trim();
    const { data, error } = await createClient()
      .rpc("support_create_ticket", {
        p_topic: topic,
        p_subject: s,
        p_body: b,
        p_client_request_id: attempt.keyFor(`${topic}|${s}|${b}`),
      })
      .single<SupportTicket>();
    setSending(false);
    if (error) {
      if (serverAnswered(error)) attempt.settle();
      setError(rpcMessage(error));
      return;
    }
    attempt.settle();
    setTopic("");
    setSubject("");
    setBody("");
    notify({ title: t("submitted") });
    onCreated(data);
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-xl border bg-card p-4">
      <div className="space-y-1.5">
        <p id="support-topic-label" className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {t("topic")}
        </p>
        <Select.Root value={topic} onValueChange={setTopic}>
          <Select.Trigger
            aria-labelledby="support-topic-label"
            className="flex h-11 w-full items-center gap-2 rounded-lg border bg-muted/40 px-3 text-left text-base outline-none focus-visible:ring-3 focus-visible:ring-ring/50 data-placeholder:text-muted-foreground"
          >
            <Select.Value placeholder={t("topicPlaceholder")} />
            <Select.Icon className="ml-auto">
              <ChevronDown className="size-4 text-muted-foreground" />
            </Select.Icon>
          </Select.Trigger>
          <Select.Portal>
            <Select.Content
              position="popper"
              sideOffset={6}
              className="z-50 w-(--radix-select-trigger-width) overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg origin-(--radix-select-content-transform-origin) ease-out-strong data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:duration-180 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:duration-120 motion-reduce:data-[state=open]:zoom-in-100 motion-reduce:data-[state=closed]:zoom-out-100"
            >
              <Select.Viewport className="p-1">
                {SUPPORT_TOPICS.map((value) => (
                  <Select.Item
                    key={value}
                    value={value}
                    className="flex h-11 cursor-pointer items-center gap-2 rounded-lg px-3 text-sm outline-none data-highlighted:bg-muted"
                  >
                    <Select.ItemText>{t(`topics.${value}`)}</Select.ItemText>
                    <Select.ItemIndicator className="ml-auto">
                      <Check className="size-4 text-primary" />
                    </Select.ItemIndicator>
                  </Select.Item>
                ))}
              </Select.Viewport>
            </Select.Content>
          </Select.Portal>
        </Select.Root>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="support-subject" className="text-xs tracking-wide text-muted-foreground uppercase">
          {t("subject")}
        </Label>
        <Input
          id="support-subject"
          maxLength={SUBJECT_MAX}
          placeholder={t("subjectPlaceholder")}
          className="h-11 bg-muted/40 text-base"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
      </div>

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
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold break-words">{ticket.subject}</p>
            <p className="text-xs text-muted-foreground">{t(`topics.${ticket.topic}`)}</p>
          </div>
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
