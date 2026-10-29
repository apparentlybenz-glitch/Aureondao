"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { FormError } from "@/components/auth/field";
import { useRpcMessage } from "@/components/app/use-rpc-message";
import { Button } from "@/components/ui/button";
import { useAttemptKey } from "@/lib/attempt-key";
import { serverAnswered } from "@/lib/rpc-error";
import { fetchMessages, type SupportMessage } from "@/lib/support";
import { BODY_MAX, bodyOk } from "@/lib/support-rules";
import { createClient } from "@/lib/supabase/client";
import { useHydrated } from "@/lib/use-hydrated";
import { cn } from "@/lib/utils";

export const supportDate = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

export const textareaClass =
  "min-h-36 w-full resize-y rounded-lg border border-input bg-transparent px-3 py-2 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

// The thread's messages, oldest first. undefined while loading, null if it failed.
export function useMessages(ticketId: string) {
  const [messages, setMessages] = useState<SupportMessage[] | null | undefined>(undefined);
  useEffect(() => {
    let active = true;
    fetchMessages(ticketId).then((m) => {
      if (active) setMessages(m);
    });
    return () => {
      active = false;
    };
  }, [ticketId]);
  return { messages, append: (m: SupportMessage) => setMessages((list) => [...(list ?? []), m]) };
}

// Staff messages always carry the "AureonX Support" label, never an admin's name.
export function MessageList({ messages, userLabel }: { messages: SupportMessage[] | null | undefined; userLabel: string }) {
  const t = useTranslations("Support");
  const c = useTranslations("Common");
  if (messages === undefined) return <p className="text-sm">{c("loading")}</p>;
  if (messages === null) return <p className="text-sm text-destructive">{t("loadError")}</p>;
  return (
    <ol className="space-y-3">
      {messages.map((m) => (
        <li
          key={m.id}
          className={cn(
            "space-y-1 rounded-xl border p-3",
            m.is_staff ? "mr-6 border-primary/30 bg-primary/10" : "ml-6 bg-muted/40",
          )}
        >
          <p className="flex justify-between gap-3 text-xs">
            <span className={cn("font-semibold", m.is_staff && "text-primary")}>{m.is_staff ? t("staffLabel") : userLabel}</span>
            <span className="text-muted-foreground">{supportDate.format(new Date(m.created_at))}</span>
          </p>
          <p className="text-sm break-words whitespace-pre-wrap">{m.body}</p>
        </li>
      ))}
    </ol>
  );
}

export function Counter({ value }: { value: string }) {
  const t = useTranslations("Support");
  return <p className="text-right text-xs text-muted-foreground">{t("counter", { count: value.length, max: BODY_MAX })}</p>;
}

// Reply box for both sides. support_reply decides from the caller whether the
// message is from staff; the client never sends that flag.
export function ReplyBox({ ticketId, onSent }: { ticketId: string; onSent: (m: SupportMessage) => void }) {
  const t = useTranslations("Support");
  const rpcMessage = useRpcMessage();
  const hydrated = useHydrated();
  const attempt = useAttemptKey();
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = bodyOk(body);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || sending) return;
    setSending(true);
    setError(null);
    const text = body.trim();
    const { data, error } = await createClient()
      .rpc("support_reply", { p_ticket_id: ticketId, p_body: text, p_client_request_id: attempt.keyFor(text) })
      .single<SupportMessage>();
    setSending(false);
    if (error) {
      if (serverAnswered(error)) attempt.settle();
      setError(rpcMessage(error));
      return;
    }
    attempt.settle();
    setBody("");
    onSent(data);
  }

  return (
    <form onSubmit={send} className="space-y-1.5">
      <label htmlFor="support-reply" className="text-sm font-medium">
        {t("reply")}
      </label>
      <textarea
        id="support-reply"
        maxLength={BODY_MAX}
        placeholder={t("replyPlaceholder")}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        className={cn(textareaClass, "min-h-24")}
      />
      <Counter value={body} />
      <FormError message={error} />
      <Button type="submit" className="h-11 w-full" disabled={!hydrated || !valid || sending}>
        {sending ? t("sending") : t("send")}
      </Button>
    </form>
  );
}
