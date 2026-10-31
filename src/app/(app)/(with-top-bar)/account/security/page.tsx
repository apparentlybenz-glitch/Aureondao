"use client";

import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { InfoCard, InfoRow, StatusPill } from "@/components/account/info-card";
import { Field, FormError } from "@/components/auth/field";
import { PasswordInput } from "@/components/auth/password-input";
import { useAuthMessage } from "@/components/auth/use-auth-message";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { useHydrated } from "@/lib/use-hydrated";

type Enrollment = { factorId: string; qr: string; secret: string };

// Security Center in the Profile page's card and row layout: Account protection
// (authenticator app, password) and More sign-in options (not available yet).
export default function SecurityPage() {
  const t = useTranslations("Security");
  const c = useTranslations("Common");
  const authMessage = useAuthMessage();
  const [totpFactorId, setTotpFactorId] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [totpError, setTotpError] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const [pwDone, setPwDone] = useState(false);

  const loadFactors = useCallback(async () => {
    const { data } = await createClient().auth.mfa.listFactors();
    setTotpFactorId(data?.totp[0]?.id ?? null);
  }, []);

  useEffect(() => {
    // Fetch, then set state in the promise callback (not synchronously in the effect).
    createClient()
      .auth.mfa.listFactors()
      .then(({ data }) => setTotpFactorId(data?.totp[0]?.id ?? null));
  }, []);

  async function startEnroll() {
    setTotpError(null);
    const supabase = createClient();
    // Drop leftover unverified factors so a retry can enroll again.
    const { data: factors } = await supabase.auth.mfa.listFactors();
    for (const f of factors?.all ?? []) {
      if (f.factor_type === "totp" && f.status === "unverified") {
        await supabase.auth.mfa.unenroll({ factorId: f.id });
      }
    }
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp" });
    if (error) setTotpError(authMessage(error));
    else setEnrollment({ factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
  }

  async function verifyEnroll(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!enrollment) return;
    setTotpError(null);
    const code = String(new FormData(e.currentTarget).get("totp")).trim();
    const { error } = await createClient().auth.mfa.challengeAndVerify({
      factorId: enrollment.factorId,
      code,
    });
    if (error) {
      setTotpError(authMessage(error));
      return;
    }
    setEnrollment(null);
    await loadFactors();
  }

  async function removeTotp() {
    if (!totpFactorId) return;
    setTotpError(null);
    const supabase = createClient();
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal?.currentLevel !== "aal2") {
      setTotpError(t("totpNeedsAal2"));
      return;
    }
    const { error } = await supabase.auth.mfa.unenroll({ factorId: totpFactorId });
    if (error) setTotpError(authMessage(error));
    else await loadFactors();
  }

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold">{t("title")}</h1>

      <InfoCard title={t("protectionTitle")}>
        <div>
          <InfoRow
            label={t("totpTitle")}
            action={
              totpFactorId ? (
                <Button type="button" variant="destructive" size="sm" onClick={removeTotp}>
                  {t("totpDisable")}
                </Button>
              ) : enrollment ? null : (
                <Button type="button" variant="secondary" size="sm" onClick={startEnroll}>
                  {t("totpEnable")}
                </Button>
              )
            }
          >
            <StatusPill on={!!totpFactorId}>{totpFactorId ? t("totpOn") : t("totpOff")}</StatusPill>
          </InfoRow>
          {enrollment ? (
            <form onSubmit={verifyEnroll} className="space-y-3 pb-3">
              <p className="text-sm text-muted-foreground">{t("totpScan")}</p>
              <Image src={enrollment.qr} alt="" width={176} height={176} className="rounded bg-white p-2" />
              <p className="text-xs">
                {t("totpSecret")}: <code className="break-all">{enrollment.secret}</code>
              </p>
              <Field id="totp" label={t("totpCode")} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required />
              <div className="flex gap-2">
                <Button type="submit" className="h-10 flex-1 md:flex-none md:px-5">
                  {t("totpVerify")}
                </Button>
                <Button type="button" variant="secondary" className="h-10 flex-1 md:flex-none md:px-5" onClick={() => setEnrollment(null)}>
                  {c("cancel")}
                </Button>
              </div>
            </form>
          ) : null}
          {totpError ? (
            <div className="pb-3">
              <FormError message={totpError} />
            </div>
          ) : null}
        </div>

        {changing ? (
          <PasswordForm
            onDone={(changed) => {
              setChanging(false);
              setPwDone(changed);
            }}
          />
        ) : (
          <InfoRow
            label={t("passwordLabel")}
            action={
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  setPwDone(false);
                  setChanging(true);
                }}
              >
                {t("passwordChange")}
              </Button>
            }
          >
            {pwDone ? <span className="text-primary">{t("passwordChanged")}</span> : t("passwordMask")}
          </InfoRow>
        )}
      </InfoCard>

      <InfoCard title={t("moreTitle")}>
        <InfoRow label={t("passkeysTitle")}>
          <StatusPill>{t("unavailable")}</StatusPill>
        </InfoRow>
        <InfoRow label={t("phoneTitle")}>
          <StatusPill>{t("unavailable")}</StatusPill>
        </InfoRow>
      </InfoCard>
    </div>
  );
}

// Inline password change, opened from the Password row like the Profile nickname edit.
// The submit waits for hydration (CLAUDE.md: a native GET submit would put the
// password in the URL).
function PasswordForm({ onDone }: { onDone: (changed: boolean) => void }) {
  const t = useTranslations("Security");
  const c = useTranslations("Common");
  const authMessage = useAuthMessage();
  const hydrated = useHydrated();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const password = String(new FormData(e.currentTarget).get("new-password"));
    const { error } = await createClient().auth.updateUser({ password });
    setSaving(false);
    if (error) setError(authMessage(error));
    else onDone(true);
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2 py-3">
      <label htmlFor="new-password" className="text-xs text-muted-foreground md:text-sm">
        {t("newPassword")}
      </label>
      <div className="md:max-w-xs">
        <PasswordInput id="new-password" name="new-password" className="h-10" autoComplete="new-password" required autoFocus />
      </div>
      <div className="flex gap-2">
        <Button type="submit" className="h-10 flex-1 md:flex-none md:px-5" disabled={!hydrated || saving}>
          {saving ? c("loading") : t("passwordSubmit")}
        </Button>
        <Button type="button" variant="secondary" className="h-10 flex-1 md:flex-none md:px-5" onClick={() => onDone(false)}>
          {c("cancel")}
        </Button>
      </div>
      <FormError message={error} />
    </form>
  );
}
