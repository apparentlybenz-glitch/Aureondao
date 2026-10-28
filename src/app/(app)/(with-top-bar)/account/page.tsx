"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { SignOutButton } from "@/components/app/sign-out-button";
import { useRpcMessage } from "@/components/app/use-rpc-message";
import { ChevronRight } from "lucide-react";
import { Field, FormError } from "@/components/auth/field";
import { KycBadge } from "@/components/kyc/kyc-badge";
import { Button } from "@/components/ui/button";
import { countryName } from "@/lib/countries";
import { kycState, useOwnKyc } from "@/lib/kyc";
import { createClient } from "@/lib/supabase/client";

type Profile = {
  uid: string;
  email: string | null;
  nickname: string;
  phone: string | null;
};

export default function AccountPage() {
  const t = useTranslations("Account");
  const c = useTranslations("Common");
  const k = useTranslations("Kyc");
  const rpcMessage = useRpcMessage();
  // Identity verification and Country both come from the latest KYC submission.
  const { kyc } = useOwnKyc();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    createClient()
      .from("profiles")
      .select("uid::text, email, nickname, phone")
      .single<Profile>()
      .then(({ data, error }) => {
        if (error) setError(error);
        else setProfile(data);
      });
  }, []);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus("saving");
    setError(null);
    const form = new FormData(e.currentTarget);
    const { data, error } = await createClient()
      .rpc("update_profile", {
        p_nickname: String(form.get("nickname")),
        p_phone: String(form.get("phone")),
      })
      .single<Profile>();
    if (error) {
      setError(error);
      setStatus("idle");
      return;
    }
    setProfile(data);
    setStatus("saved");
  }

  if (!profile) {
    return error ? <FormError message={rpcMessage(error)} /> : <p className="text-sm">{c("loading")}</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t("profileTitle")}</h1>
        <SignOutButton />
      </div>

      <dl className="grid gap-3 rounded-xl border p-4 text-sm md:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">{t("uid")}</dt>
          <dd className="flex items-center gap-2 font-mono">
            {profile.uid}
            <Button
              variant="ghost"
              size="xs"
              onClick={async () => {
                await navigator.clipboard.writeText(String(profile.uid));
                setCopied(true);
              }}
            >
              {copied ? t("copied") : t("copyUid")}
            </Button>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("email")}</dt>
          <dd className="break-all">{profile.email}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("country")}</dt>
          <dd>{kyc?.current ? countryName(kyc.current.country) : t("countryEmpty")}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{k("title")}</dt>
          <dd>
            <Link href="/account/verification" className="-my-1 inline-flex h-8 items-center gap-1.5">
              {kyc ? <KycBadge state={kycState(kyc.current)} /> : <span>{t("countryEmpty")}</span>}
              <ChevronRight className="size-4 text-muted-foreground" />
            </Link>
          </dd>
        </div>
      </dl>

      <form onSubmit={onSubmit} className="grid gap-4 md:grid-cols-2" onChange={() => setStatus("idle")}>
        <Field id="nickname" label={t("nickname")} defaultValue={profile.nickname} maxLength={32} required />
        <Field id="phone" type="tel" label={t("phone")} defaultValue={profile.phone ?? ""} autoComplete="tel" />
        <div className="space-y-2 md:col-span-2">
          <FormError message={error ? rpcMessage(error) : null} />
          <Button type="submit" className="h-10 w-full md:w-auto" disabled={status === "saving"}>
            {status === "saving" ? c("loading") : status === "saved" ? c("saved") : c("save")}
          </Button>
        </div>
      </form>
    </div>
  );
}
