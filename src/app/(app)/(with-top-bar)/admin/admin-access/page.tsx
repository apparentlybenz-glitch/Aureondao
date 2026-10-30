"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { FormError } from "@/components/auth/field";
import { AdminHeading } from "@/components/admin/admin-heading";
import { SelectedUserCard, useSelectedUser, UserSearch } from "@/components/admin/selected-user";
import { useRpcMessage } from "@/components/app/use-rpc-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type AdminRole, type AdminUser, fetchAdminRole } from "@/lib/admin";
import { useAttemptKey } from "@/lib/attempt-key";
import { serverAnswered } from "@/lib/rpc-error";
import { createClient } from "@/lib/supabase/client";
import { useHeadAdmin } from "@/lib/use-head-admin";
import { cn } from "@/lib/utils";

type Action = "grant" | "revoke" | "demote" | "remove";
const LABEL = { grant: "access.grant", revoke: "access.revoke", demote: "access.demote", remove: "access.remove" } as const;
const DONE = { grant: "access.doneGranted", revoke: "access.doneRevoked", demote: "access.doneDemoted", remove: "access.doneRevoked" } as const;

export default function AdminAccessPage() {
  const t = useTranslations("Admin");
  const c = useTranslations("Common");
  const viewer = useHeadAdmin();
  const { user, select } = useSelectedUser();

  if (viewer === null) return <p className="text-sm">{c("loading")}</p>;
  if (!viewer.isHead) return <p className="text-sm text-muted-foreground">{t("access.notAllowed")}</p>;

  return (
    <>
      <AdminHeading title={t("sections.adminAccess")} description={t("access.description")} />
      {user ? (
        <div className="space-y-5">
          <SelectedUserCard user={user} onChange={() => select(null)} changeLabel={t("access.change")} />
          <AccessForm key={user.id} user={user} viewerIsOwner={viewer.isOwner} />
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{t("access.pickUser")}</p>
          <UserSearch onPick={select} />
        </div>
      )}
    </>
  );
}

function AccessForm({ user, viewerIsOwner }: { user: AdminUser; viewerIsOwner: boolean }) {
  const t = useTranslations("Admin");
  const c = useTranslations("Common");
  const rpcMessage = useRpcMessage();
  const attempt = useAttemptKey();
  // undefined while loading, null when the read failed.
  const [role, setRole] = useState<AdminRole | null | undefined>(undefined);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetchAdminRole(user.id).then((r) => {
      if (active) setRole(r);
    });
    return () => {
      active = false;
    };
  }, [user.id]);

  if (role === undefined) return <p className="text-sm">{c("loading")}</p>;
  if (role === null) return <p className="text-sm text-destructive">{t("loadError")}</p>;

  // The owner is never changed in the app. A head admin is changed only by the owner,
  // through admin_demote_head; admin_set_admin refuses it.
  const actions: Action[] = role.isOwner ? [] : role.isHead ? (viewerIsOwner ? ["demote", "remove"] : []) : [role.isAdmin ? "revoke" : "grant"];
  const trimmed = reason.trim();
  const validReason = trimmed.length >= 3 && trimmed.length <= 200;
  const email = user.email ?? user.nickname;

  async function submit(action: Action) {
    if (pending || !validReason) return;
    setPending(true);
    setError(null);
    setDone(null);
    const key = attempt.keyFor(`${user.id}|${action}|${trimmed}`);
    const supabase = createClient();
    const { error } =
      action === "demote" || action === "remove"
        ? await supabase.rpc("admin_demote_head", {
            p_user_id: user.id,
            p_remove_admin: action === "remove",
            p_reason: trimmed,
            p_client_request_id: key,
          })
        : await supabase.rpc("admin_set_admin", {
            p_user_id: user.id,
            p_make_admin: action === "grant",
            p_reason: trimmed,
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
    setDone(t(DONE[action], { email }));
    setReason("");
    setRole(await fetchAdminRole(user.id));
  }

  return (
    <section className="space-y-4 rounded-xl border bg-card p-4">
      <div className="space-y-1">
        <p className="flex items-center gap-2 text-sm font-medium">
          {t("access.status")}
          <span
            className={cn(
              "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold",
              role.isAdmin ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
            )}
          >
            {role.isOwner ? t("access.owner") : role.isHead ? t("access.head") : role.isAdmin ? t("access.admin") : t("access.notAdmin")}
          </span>
        </p>
        {role.isOwner ? (
          <p className="text-xs text-muted-foreground">{t("access.ownerNote")}</p>
        ) : role.isHead ? (
          <p className="text-xs text-muted-foreground">{t(viewerIsOwner ? "access.headNoteOwner" : "access.headNote")}</p>
        ) : null}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (actions.length === 1) submit(actions[0]);
        }}
        className="space-y-4"
      >
        <div className="space-y-1.5">
          <Label htmlFor="access-reason">{t("access.reasonField")}</Label>
          <Input
            id="access-reason"
            maxLength={200}
            disabled={actions.length === 0}
            className="h-11 text-base"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <FormError message={error} />
        {done ? (
          <p role="status" className="text-sm text-up">
            {done}
          </p>
        ) : null}
        {actions.length === 0 ? (
          <Button type="button" variant="destructive" className="h-11 w-full" disabled>
            {t("access.revoke")}
          </Button>
        ) : (
          actions.map((action) => (
            <Button
              key={action}
              type={actions.length === 1 ? "submit" : "button"}
              variant={action === "grant" ? "default" : "destructive"}
              className="h-11 w-full"
              disabled={pending || !validReason}
              onClick={actions.length === 1 ? undefined : () => submit(action)}
            >
              {pending ? t("access.sending") : t(LABEL[action])}
            </Button>
          ))
        )}
      </form>
    </section>
  );
}
