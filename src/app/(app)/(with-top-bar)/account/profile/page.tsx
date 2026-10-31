"use client";

import Link from "next/link";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Avatar } from "@/components/account/avatar";
import { CopyButton } from "@/components/account/copy-button";
import { InfoCard, InfoRow } from "@/components/account/info-card";
import { SignOutButton } from "@/components/app/sign-out-button";
import { useRpcMessage } from "@/components/app/use-rpc-message";
import { FormError } from "@/components/auth/field";
import { KycBadge } from "@/components/kyc/kyc-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { countryName } from "@/lib/countries";
import { kycState, useOwnKyc } from "@/lib/kyc";
import { PROFILE_SELECT, reportProfileError, useOwnProfile, type OwnProfile, type ProfileError } from "@/lib/own-profile";
import { createClient } from "@/lib/supabase/client";

const NICKNAME_MAX = 8;

export default function AccountProfilePage() {
  const t = useTranslations("Account");
  const c = useTranslations("Common");
  const k = useTranslations("Kyc");
  const rpcMessage = useRpcMessage();
  const { kyc } = useOwnKyc();
  const { profile, setProfile, error } = useOwnProfile();
  const [editing, setEditing] = useState(false);

  if (!profile) {
    return error ? <FormError message={rpcMessage(error)} /> : <p className="text-sm">{c("loading")}</p>;
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t("profileTitle")}</h1>
        <SignOutButton />
      </div>

      <InfoCard title={t("accountInfo")}>
        <div className="py-3">
          <Avatar />
        </div>
        {editing ? (
          <NicknameForm
            profile={profile}
            onDone={(next) => {
              if (next) setProfile(next);
              setEditing(false);
            }}
          />
        ) : (
          <InfoRow
            label={t("nickname")}
            action={
              <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(true)}>
                {t("edit")}
              </Button>
            }
          >
            {profile.nickname}
          </InfoRow>
        )}
        <InfoRow label={t("uid")} action={<CopyButton value={profile.uid} label={t("copyUid")} />}>
          <span className="font-mono">{profile.uid}</span>
        </InfoRow>
        <InfoRow label={t("email")} action={profile.email ? <CopyButton value={profile.email} label={t("copyEmail")} /> : null}>
          {profile.email ?? "--"}
        </InfoRow>
      </InfoCard>

      <InfoCard title={t("kycDetails")}>
        <InfoRow
          label={k("title")}
          action={
            <Button asChild variant="secondary" size="sm">
              <Link href="/account/verification">{t("viewDetails")}</Link>
            </Button>
          }
        >
          {kyc ? <KycBadge state={kycState(kyc.current)} /> : t("countryEmpty")}
        </InfoRow>
        <InfoRow label={t("country")}>{kyc?.current ? countryName(kyc.current.country) : t("countryEmpty")}</InfoRow>
      </InfoCard>
    </div>
  );
}

// Inline nickname edit through update_profile. The RPC always writes phone, so the
// stored value is passed back unchanged; no screen edits it.
function NicknameForm({ profile, onDone }: { profile: OwnProfile; onDone: (next: OwnProfile | null) => void }) {
  const t = useTranslations("Account");
  const c = useTranslations("Common");
  const rpcMessage = useRpcMessage();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ProfileError | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const nickname = String(new FormData(e.currentTarget).get("nickname"));
    const { data, error } = await createClient()
      .rpc("update_profile", { p_nickname: nickname, p_phone: profile.phone ?? "" })
      .select(PROFILE_SELECT)
      .single<OwnProfile>();
    setSaving(false);
    if (error) {
      reportProfileError("save", error);
      setError(error);
      return;
    }
    onDone(data);
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2 py-3">
      <label htmlFor="nickname" className="text-xs text-muted-foreground md:text-sm">
        {t("nickname")}
      </label>
      <div className="flex flex-col gap-2 md:flex-row">
        <Input
          id="nickname"
          name="nickname"
          className="h-10 md:max-w-xs"
          defaultValue={profile.nickname}
          maxLength={NICKNAME_MAX}
          required
          autoFocus
        />
        <div className="flex gap-2">
          <Button type="submit" className="h-10 flex-1 md:flex-none md:px-5" disabled={saving}>
            {saving ? c("loading") : c("save")}
          </Button>
          <Button type="button" variant="secondary" className="h-10 flex-1 md:flex-none md:px-5" onClick={() => onDone(null)}>
            {c("cancel")}
          </Button>
        </div>
      </div>
      <FormError message={error ? rpcMessage(error) : null} />
    </form>
  );
}
