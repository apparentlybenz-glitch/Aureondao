"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { FormError } from "@/components/auth/field";
import { AdminHeading } from "@/components/admin/admin-heading";
import { SelectedUserCard, useSelectedUser, UserSearch } from "@/components/admin/selected-user";
import { StateBadge } from "@/components/admin/state-badge";
import { useRpcMessage } from "@/components/app/use-rpc-message";
import { Button } from "@/components/ui/button";
import type { AdminUser } from "@/lib/admin";
import { useAttemptKey } from "@/lib/attempt-key";
import { serverAnswered } from "@/lib/rpc-error";
import { createClient } from "@/lib/supabase/client";

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

export default function RestrictionsPage() {
  const t = useTranslations("Admin");
  const { user, select, reload } = useSelectedUser();
  return (
    <>
      <AdminHeading title={t("sections.restrictions")} description={t("restrictions.description")} />
      {user ? (
        <div className="space-y-5">
          <SelectedUserCard user={user} onChange={() => select(null)} changeLabel={t("restrictions.change")} />
          <SuspensionForm key={`${user.id}:${user.suspended_at}`} user={user} onChanged={reload} />
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{t("restrictions.pickUser")}</p>
          <UserSearch onPick={select} />
        </div>
      )}
    </>
  );
}

function SuspensionForm({ user, onChanged }: { user: AdminUser; onChanged: () => Promise<void> }) {
  const t = useTranslations("Admin");
  const rpcMessage = useRpcMessage();
  const attempt = useAttemptKey();
  const suspended = user.suspended_at !== null;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    setDone(null);
    const key = attempt.keyFor(`${user.id}|${!suspended}`);
    const { error } = await createClient().rpc("admin_set_suspension", {
      p_user_id: user.id,
      p_suspended: !suspended,
      p_client_request_id: key,
    });
    setPending(false);
    if (error) {
      // Without a server answer the change may have run: keep the key so a retry
      // of this attempt writes one audit row.
      if (serverAnswered(error)) attempt.settle();
      setError(rpcMessage(error));
      return;
    }
    attempt.settle();
    setDone(t(suspended ? "restrictions.doneActive" : "restrictions.doneSuspended", { email: user.email ?? user.nickname }));
    await onChanged();
  }

  return (
    <section className="space-y-4 rounded-xl border bg-card p-4">
      <div className="space-y-1">
        <p className="flex items-center gap-2 text-sm font-medium">
          {t("restrictions.status")}
          <StateBadge suspended={suspended} />
        </p>
        {user.suspended_at ? (
          <p className="text-xs text-muted-foreground">
            {t("restrictions.since", { date: dateFormat.format(new Date(user.suspended_at)) })}
          </p>
        ) : null}
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        <FormError message={error} />
        {done ? (
          <p role="status" className="text-sm text-up">
            {done}
          </p>
        ) : null}
        <Button type="submit" variant={suspended ? "default" : "destructive"} className="h-11 w-full" disabled={pending}>
          {pending ? t("restrictions.sending") : suspended ? t("restrictions.unsuspend") : t("restrictions.suspend")}
        </Button>
      </form>
    </section>
  );
}
