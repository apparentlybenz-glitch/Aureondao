"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { notify } from "@/lib/notify";
import { onVisible } from "@/lib/on-visible";
import { createClient } from "@/lib/supabase/client";

type Row = { id: string; kind: "support_reply"; support_tickets: { subject: string } | null };

// Shows each unread notifications row once as a toast, then marks it read.
// Loads on every Realtime (re)subscribe, on each new row and when the tab
// becomes visible, so rows written while the app was closed still pop.
export function NotificationListener() {
  const t = useTranslations("Notifications");

  useEffect(() => {
    const supabase = createClient();
    const shown = new Set<string>();
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let stopVisible = () => {};
    let active = true;

    async function load(userId: string) {
      const { data, error } = await supabase
        .from("notifications")
        .select("id, kind, support_tickets(subject)")
        .eq("user_id", userId)
        .is("read_at", null)
        .order("created_at")
        .limit(20)
        .overrideTypes<Row[], { merge: false }>();
      if (!active || error) return;
      const fresh = data.filter((n) => !shown.has(n.id));
      if (fresh.length === 0) return;
      for (const n of fresh) {
        shown.add(n.id);
        notify({ title: t("supportReply"), description: n.support_tickets?.subject, href: "/support" });
      }
      await supabase.rpc("mark_notifications_read", { p_ids: fresh.map((n) => n.id) });
    }

    supabase.auth.getSession().then(({ data }) => {
      const userId = data.session?.user.id;
      if (!userId || !active) return;
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
