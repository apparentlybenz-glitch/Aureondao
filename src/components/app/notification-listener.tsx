"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { notify } from "@/lib/notify";
import { onVisible } from "@/lib/on-visible";
import { reportTicketActivity } from "@/lib/support";
import { createClient } from "@/lib/supabase/client";

type Kind = "support_reply" | "support_new_ticket" | "support_user_reply";
type Row = { id: string; kind: Kind; ticket_id: string | null; support_tickets: { subject: string } | null };

// More admin rows than this on the first load become one summary toast.
const SUMMARY_OVER = 3;
const LIMIT = 500;

// Shows each unread notifications row once as a toast, then marks it read.
// Loads once the session is known, on every Realtime (re)subscribe, on each new
// row and when the tab becomes visible, so rows written while the app was closed
// pop on the first page after sign-in. 'support_reply' rows are the owner's
// (link to /support); 'support_new_ticket' and 'support_user_reply' are admin
// rows (link to that ticket in /admin/support). Each row's ticket is reported to
// reportTicketActivity, so an open thread on either side refetches.
export function NotificationListener() {
  const t = useTranslations("Notifications");

  useEffect(() => {
    const supabase = createClient();
    const shown = new Set<string>();
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let stopVisible = () => {};
    let active = true;
    let first = true;

    async function load(userId: string) {
      const { data, error } = await supabase
        .from("notifications")
        .select("id, kind, ticket_id, support_tickets(subject)")
        .eq("user_id", userId)
        .is("read_at", null)
        .order("created_at")
        .limit(LIMIT)
        .overrideTypes<Row[], { merge: false }>();
      if (!active || error) return;
      const wasFirst = first;
      first = false;
      const fresh = data.filter((n) => !shown.has(n.id));
      if (fresh.length === 0) return;
      for (const n of fresh) shown.add(n.id);

      const admin = fresh.filter((n) => n.kind !== "support_reply");
      for (const n of fresh) {
        if (n.kind === "support_reply") {
          notify({ title: t("supportReply"), description: n.support_tickets?.subject, href: "/support" });
        }
      }
      if (wasFirst && admin.length > SUMMARY_OVER) {
        notify({ title: t("adminSummary", { count: admin.length }), href: "/admin/support" });
      } else {
        for (const n of admin) {
          const subject = n.support_tickets?.subject ?? "";
          notify({
            title: t(n.kind === "support_new_ticket" ? "newTicket" : "newReply", { subject }),
            href: n.ticket_id ? `/admin/support?ticket=${n.ticket_id}` : "/admin/support",
          });
        }
      }
      for (const n of fresh) if (n.ticket_id) reportTicketActivity(n.ticket_id);
      await supabase.rpc("mark_notifications_read", { p_ids: fresh.map((n) => n.id) });
    }

    supabase.auth.getSession().then(({ data }) => {
      const userId = data.session?.user.id;
      if (!userId || !active) return;
      void load(userId);
      channel = supabase
        .channel(`notifications:${crypto.randomUUID()}`)
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${userId}` },
          () => void load(userId),
        )
        .subscribe((status) => {
          if (status === "SUBSCRIBED") void load(userId);
        });
      stopVisible = onVisible(() => void load(userId));
    });

    return () => {
      active = false;
      stopVisible();
      if (channel) void supabase.removeChannel(channel);
    };
  }, [t]);

  return null;
}
