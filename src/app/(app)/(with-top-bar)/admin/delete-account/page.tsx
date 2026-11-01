"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { FormError } from "@/components/auth/field";
import { AdminHeading } from "@/components/admin/admin-heading";
import { SelectedUserCard, useSelectedUser, UserSearch } from "@/components/admin/selected-user";
import { useRpcMessage } from "@/components/app/use-rpc-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AdminUser } from "@/lib/admin";
import { useAttemptKey } from "@/lib/attempt-key";
import { serverAnswered } from "@/lib/rpc-error";
import { createClient } from "@/lib/supabase/client";

export default function DeleteAccountPage() {
  const t = useTranslations("Admin");
  const { user, select } = useSelectedUser();
  const [done, setDone] = useState<string | null>(null);

  return (
    <>
      <AdminHeading destructive title={t("sections.deleteAccount")} description={t("deleteAccount.description")} />
      {done ? (
        <p role="status" className="mb-4 text-sm text-up">
          {done}
        </p>
      ) : null}
      {user ? (
        <div className="space-y-5">
          <SelectedUserCard user={user} onChange={() => select(null)} changeLabel={t("deleteAccount.change")} />
          <DeleteForm
            key={user.id}
            user={user}
            onDeleted={(label) => {
              setDone(t("deleteAccount.done", { email: label }));
              select(null);
            }}
          />
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{t("deleteAccount.pickUser")}</p>
          <UserSearch onPick={(u) => {
            setDone(null);
            select(u);
          }} />
        </div>
      )}
    </>
  );
}

// The admin types the user's email (their UID when there is no email) before the button
// enables. The RPC refuses yourself and any admin account.
function DeleteForm({ user, onDeleted }: { user: AdminUser; onDeleted: (label: string) => void }) {
  const t = useTranslations("Admin");
  const rpcMessage = useRpcMessage();
  const attempt = useAttemptKey();
  const label = user.email ?? user.uid;
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = typed.trim().toLowerCase() === label.toLowerCase();

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending || !matches) return;
    setPending(true);
    setError(null);
    const { error } = await createClient().rpc("admin_delete_user", {
      p_user_id: user.id,
      p_client_request_id: attempt.keyFor(user.id),
    });
    setPending(false);
    if (error) {
      // Without a server answer the delete may have run: keep the key so a retry of
      // this attempt returns the first result.
      if (serverAnswered(error)) attempt.settle();
      setError(rpcMessage(error));
      return;
    }
    attempt.settle();
    onDeleted(label);
  }

  return (
    <section className="space-y-4 rounded-xl border border-destructive/60 bg-card p-4">
      <div className="space-y-1">
        <h2 className="font-medium text-destructive">{t("deleteAccount.warningTitle")}</h2>
        <p className="text-sm text-muted-foreground">{t("deleteAccount.warning")}</p>
      </div>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="delete-confirm" className="text-sm">
            {t("deleteAccount.confirmLabel", { value: label })}
          </label>
          <Input
            id="delete-confirm"
            autoComplete="off"
            className="h-11 text-base"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </div>
        <FormError message={error} />
        <Button type="submit" variant="destructive" className="h-11 w-full" disabled={pending || !matches}>
          {pending ? t("deleteAccount.sending") : t("deleteAccount.submit")}
        </Button>
      </form>
    </section>
  );
}
