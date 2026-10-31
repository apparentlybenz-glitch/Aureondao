"use client";

import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Field, FormError } from "@/components/auth/field";
import { useAuthMessage } from "@/components/auth/use-auth-message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { useHydrated } from "@/lib/use-hydrated";

type Enrollment = { factorId: string; qr: string; secret: string };

function Row({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-xl border p-4">
      <h2 className="font-medium">{title}</h2>
      {children}
    </section>
  );
}

export default function SecurityPage() {
  const t = useTranslations("Security");
  const c = useTranslations("Common");
  const authMessage = useAuthMessage();
  const [totpFactorId, setTotpFactorId] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [totpError, setTotpError] = useState<string | null>(null);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwDone, setPwDone] = useState(false);
  const hydrated = useHydrated();

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

  async function changePassword(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPwError(null);
    setPwDone(false);
    const formEl = e.currentTarget;
    const password = String(new FormData(formEl).get("new-password"));
    const { error } = await createClient().auth.updateUser({ password });
    if (error) setPwError(authMessage(error));
    else {
      setPwDone(true);
      formEl.reset();
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{t("title")}</h1>

      <Row title={t("totpTitle")}>
        <div className="flex items-center justify-between">
          <Badge variant={totpFactorId ? "default" : "secondary"}>
            {totpFactorId ? t("totpOn") : t("totpOff")}
          </Badge>
          {totpFactorId ? (
            <Button variant="destructive" size="sm" onClick={removeTotp}>
              {t("totpDisable")}
            </Button>
          ) : (
            !enrollment && (
              <Button size="sm" onClick={startEnroll}>
                {t("totpEnable")}
              </Button>
            )
          )}
        </div>
        {enrollment && (
          <form onSubmit={verifyEnroll} className="space-y-3">
            <p className="text-sm text-muted-foreground">{t("totpScan")}</p>
            <Image src={enrollment.qr} alt="" width={176} height={176} className="rounded bg-white p-2" />
            <p className="text-xs">
              {t("totpSecret")}: <code className="break-all">{enrollment.secret}</code>
            </p>
            <Field id="totp" label={t("totpCode")} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required />
            <div className="flex gap-2">
              <Button type="submit" className="h-10">
                {t("totpVerify")}
              </Button>
              <Button type="button" variant="ghost" className="h-10" onClick={() => setEnrollment(null)}>
                {c("cancel")}
              </Button>
            </div>
          </form>
        )}
        <FormError message={totpError} />
      </Row>

      <Row title={t("passwordTitle")}>
        <form onSubmit={changePassword} className="space-y-3">
          <Field id="new-password" type="password" label={c("password")} autoComplete="new-password" required />
          <FormError message={pwError} />
          {pwDone && <p className="text-sm">{t("passwordChanged")}</p>}
          <Button type="submit" className="h-10 w-full md:w-auto" disabled={!hydrated}>
            {t("passwordSubmit")}
          </Button>
        </form>
      </Row>

      <Row title={t("passkeysTitle")}>
        <Badge variant="outline">{t("unavailable")}</Badge>
      </Row>
      <Row title={t("phoneTitle")}>
        <Badge variant="outline">{t("unavailable")}</Badge>
      </Row>
    </div>
  );
}
