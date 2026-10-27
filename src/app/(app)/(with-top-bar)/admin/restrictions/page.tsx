"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { FormError } from "@/components/auth/field";
import { AdminHeading } from "@/components/admin/admin-heading";
import { SelectedUserCard, useSelectedUser, UserSearch } from "@/components/admin/selected-user";
import { StateBadge } from "@/components/admin/state-badge";
import { useRpcMessage } from "@/components/app/use-rpc-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // Suspending needs 3 to 200 characters; unsuspending takes an optional note.
  const trimmed = reason.trim();
  const canSubmit = !pending && trimmed.length <= 200 && (suspended || trimmed.length >= 3);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSubmit) return;
    setPending(true);
    setError(null);
    setDone(null);
    const key = attempt.keyFor(`${user.id}|${!suspended}|${trimmed}`);
    const { error } = await createClient().rpc("admin_set_suspension", {
      p_user_id: user.id,
      p_suspended: !suspended,
      // Never null for a suspension (the RPC refuses it); optional for unsuspend.
      p_reason: trimmed === "" ? undefined : trimmed,
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
    setReason("");
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
        {suspended ? (
          <p className="text-sm">
            <span className="text-muted-foreground">{t("restrictions.reasonLabel")}: </span>
            {user.suspension_reason ?? t("restrictions.noReason")}
          </p>
        ) : null}
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="suspension-reason">{t("restrictions.reasonField")}</Label>
          <Input
            id="suspension-reason"
            maxLength={200}
            className="h-11 text-base"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <FormError message={error} />
        {done ? (
          <p role="status" className="text-sm text-emerald-500">
            {done}
          </p>
        ) : null}
        <Button type="submit" variant={suspended ? "default" : "destructive"} className="h-11 w-full" disabled={!canSubmit}>
          {pending ? t("restrictions.sending") : suspended ? t("restrictions.unsuspend") : t("restrictions.suspend")}
        </Button>
      </form>
    </section>
  );
}
