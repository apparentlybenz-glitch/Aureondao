"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { useTranslations } from "next-intl";
import { AdminHeading } from "@/components/admin/admin-heading";
import { FormError } from "@/components/auth/field";
import { KycBadge } from "@/components/kyc/kyc-badge";
import { useKycMessage } from "@/components/kyc/use-kyc-message";
import { Button } from "@/components/ui/button";
import { useAttemptKey } from "@/lib/attempt-key";
import { countryName } from "@/lib/countries";
import { KYC_BUCKET, KYC_SELECT, KYC_STATUSES, type KycStatus, type KycSubmission } from "@/lib/kyc";
import { serverAnswered } from "@/lib/rpc-error";
import { createClient } from "@/lib/supabase/client";

const LIMIT = 100;
const SIGNED_URL_SECONDS = 60;
type Filter = KycStatus | "all";
type Person = { email: string; uid: string };
type Loaded = { rows: KycSubmission[]; people: Map<string, Person> };

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });
const dobFormat = new Intl.DateTimeFormat("en", { dateStyle: "long", timeZone: "UTC" });

// kyc_submissions and profiles under RLS: private.is_admin() needs the admin row.
// The status enum sorts pending first.
async function loadSubmissions(filter: Filter): Promise<Loaded | null> {
  const supabase = createClient();
  let req = supabase
    .from("kyc_submissions")
    .select(KYC_SELECT)
    .order("status")
    .order("submitted_at", { ascending: false })
    .limit(LIMIT);
  if (filter !== "all") req = req.eq("status", filter);
  const { data, error } = await req.overrideTypes<KycSubmission[], { merge: false }>();
  if (error) return null;

  const ids = [...new Set(data.map((r) => r.user_id))];
  const people = new Map<string, Person>();
  if (ids.length > 0) {
    const { data: rows } = await supabase
      .from("profiles")
      .select("id, uid::text, email, nickname")
      .in("id", ids)
      .overrideTypes<{ id: string; uid: string; email: string | null; nickname: string }[], { merge: false }>();
    for (const p of rows ?? []) people.set(p.id, { email: p.email ?? p.nickname, uid: p.uid });
  }
  return { rows: data, people };
}

export default function KycReviewPage() {
  const t = useTranslations("Admin");
  const k = useTranslations("Kyc");
  const c = useTranslations("Common");
  const [filter, setFilter] = useState<Filter>("all");
  const [version, setVersion] = useState(0);
  const [result, setResult] = useState<Loaded | null | undefined>(undefined);
  // The opened submission is kept as it was picked, so a reload that filters it
  // out of the list (after a decision) does not close the detail.
  const [open, setOpen] = useState<{ row: KycSubmission; person: Person | undefined } | null>(null);

  useEffect(() => {
    let active = true;
    loadSubmissions(filter).then((r) => {
      if (active) setResult(r);
    });
    return () => {
      active = false;
    };
  }, [filter, version]);

  return (
    <>
      <AdminHeading title={t("sections.kyc")} description={t("kyc.description")} />
      {open ? (
        <ReviewDetail
          key={open.row.id}
          submission={open.row}
          person={open.person}
          onBack={() => setOpen(null)}
          onDecided={() => setVersion((v) => v + 1)}
        />
      ) : (
        <>
          <div className="mb-4 space-y-1.5">
            <label htmlFor="kyc-filter" className="block text-sm font-medium">
              {t("kyc.filter")}
            </label>
            <select
              id="kyc-filter"
              value={filter}
              onChange={(e) => {
                setResult(undefined);
                setFilter(e.target.value as Filter);
              }}
              className="h-11 w-full rounded-lg border border-input bg-input px-3 text-base outline-none focus-visible:ring-3 focus-visible:ring-ring/50 md:max-w-xs"
            >
              <option value="all">{t("kyc.all")}</option>
              {KYC_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {k(`badge.${s}`)}
                </option>
              ))}
            </select>
          </div>

          {result === undefined ? <p className="text-sm">{c("loading")}</p> : null}
          {result === null ? <p className="text-sm text-destructive">{t("loadError")}</p> : null}
          {result?.rows.length === 0 ? <p className="text-sm text-muted-foreground">{t("kyc.empty")}</p> : null}
          <ul className="space-y-2">
            {result?.rows.map((row) => {
              const person = result.people.get(row.user_id);
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    onClick={() => setOpen({ row, person })}
                    className="flex w-full items-center justify-between gap-3 rounded-xl border bg-card p-3 text-left"
                  >
                    <span className="min-w-0 space-y-0.5">
                      <span className="block truncate text-sm font-medium">{person?.email ?? row.full_name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {countryName(row.country)} · {k(`documents.${row.document_type}`)}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {t("kyc.submitted", { date: dateFormat.format(new Date(row.submitted_at)) })}
                      </span>
                    </span>
                    <KycBadge state={row.status} />
                  </button>
                </li>
              );
            })}
          </ul>
          {result && result.rows.length >= LIMIT ? (
            <p className="mt-3 text-center text-xs text-muted-foreground">{t("kyc.limit", { count: LIMIT })}</p>
          ) : null}
        </>
      )}
    </>
  );
}

function ReviewDetail({
  submission,
  person,
  onBack,
  onDecided,
}: {
  submission: KycSubmission;
  person: Person | undefined;
  onBack: () => void;
  onDecided: () => void;
}) {
  const t = useTranslations("Admin");
  const k = useTranslations("Kyc");
  const kycMessage = useKycMessage();
  const attempt = useAttemptKey();
  const [row, setRow] = useState(submission);
  const [photo, setPhoto] = useState<string | null | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // Each time the detail opens: one audit row (admin_log_kyc_photo_view), then a
  // fresh 60-second signed URL. Fail closed: when the audit call fails, no URL is
  // created. Storage RLS lets only an admin sign another user's file.
  useEffect(() => {
    let active = true;
    const supabase = createClient();
    void (async () => {
      const { error: auditError } = await supabase.rpc("admin_log_kyc_photo_view", { p_submission_id: submission.id });
      if (auditError) {
        if (active) setPhoto(null);
        return;
      }
      const { data, error } = await supabase.storage.from(KYC_BUCKET).createSignedUrl(submission.photo_path, SIGNED_URL_SECONDS);
      if (active) setPhoto(error ? null : data.signedUrl);
    })();
    return () => {
      active = false;
    };
  }, [submission.id, submission.photo_path]);

  const who = person?.email ?? row.full_name;

  async function decide(approve: boolean) {
    if (sending) return;
    setSending(true);
    setError(null);
    const key = attempt.keyFor(`${row.id}|${approve}`);
    const { data, error } = await createClient()
      .rpc("admin_review_kyc", {
        p_submission_id: row.id,
        p_approve: approve,
        p_client_request_id: key,
      })
      .single<KycSubmission>();
    setSending(false);
    if (error) {
      // Without a server answer the review may have run: keep the key so a retry
      // of this attempt writes one audit row.
      if (serverAnswered(error)) attempt.settle();
      setError(kycMessage(error));
      return;
    }
    attempt.settle();
    setRow({ ...row, ...data });
    setDone(t(approve ? "kyc.doneApproved" : "kyc.doneRejected", { email: who }));
    onDecided();
  }

  return (
    <div className="space-y-4">
      <Button type="button" variant="ghost" className="-ml-2 h-9 gap-1 px-2" onClick={onBack}>
        <ChevronLeft className="size-4" />
        {t("kyc.backToList")}
      </Button>

      <section className="space-y-4 rounded-xl border bg-card p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{who}</p>
            {person ? <p className="font-mono text-xs text-muted-foreground">{t("uid", { uid: person.uid })}</p> : null}
          </div>
          <KycBadge state={row.status} />
        </div>

        <div className="md:grid md:grid-cols-2 md:gap-4">
          <dl className="space-y-2 text-sm">
            <Field label={k("country")} value={countryName(row.country)} />
            <Field label={k("documentType")} value={k(`documents.${row.document_type}`)} />
            <Field label={k("fullName")} value={row.full_name} />
            <Field label={k("dateOfBirth")} value={dobFormat.format(new Date(`${row.date_of_birth}T00:00:00Z`))} />
            <Field label={k("city")} value={row.city} />
            <Field label={t("kyc.submittedLabel")} value={dateFormat.format(new Date(row.submitted_at))} />
            {row.decided_at ? <Field label={t("kyc.decidedLabel")} value={dateFormat.format(new Date(row.decided_at))} /> : null}
          </dl>

          <div className="mt-4 space-y-1.5 md:mt-0">
            <p className="text-sm font-medium">{t("kyc.photo")}</p>
            <div className="relative aspect-[4/3] w-full overflow-hidden rounded-lg border bg-black/40">
              {photo ? (
                <Image src={photo} alt={t("kyc.photo")} fill sizes="(min-width: 768px) 320px, 100vw" className="object-contain" />
              ) : (
                <p className="flex h-full items-center justify-center p-3 text-center text-xs text-muted-foreground">
                  {photo === null ? t("kyc.photoError") : null}
                </p>
              )}
            </div>
            <p className="text-xs text-muted-foreground">{t("kyc.photoNote")}</p>
          </div>
        </div>

        {done ? (
          <p role="status" className="text-sm text-up">
            {done}
          </p>
        ) : null}

        {row.status === "pending" ? (
          <div className="space-y-3 border-t pt-4">
            <FormError message={error} />
            <div className="flex gap-2">
              <Button type="button" variant="destructive" className="h-11 flex-1" disabled={sending} onClick={() => decide(false)}>
                {sending ? t("kyc.sending") : t("kyc.reject")}
              </Button>
              <Button type="button" className="h-11 flex-1" disabled={sending} onClick={() => decide(true)}>
                {sending ? t("kyc.sending") : t("kyc.approve")}
              </Button>
            </div>
          </div>
        ) : (
          <FormError message={error} />
        )}
      </section>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right break-words">{value}</dd>
    </div>
  );
}
